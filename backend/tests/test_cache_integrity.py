"""A failed or stale analysis must never be served from the shared result cache."""

import asyncio
import json

import pytest

import core.agent_factory as agent_factory
import core.agent_prompts as agent_prompts
from config import settings
from core.agent_definitions import (
    clause_checker_agent,
    document_detector_agent,
    risk_detector_agent,
    summarizer_agent,
)
from infrastructure import cache_manager, model_manager
from services.analysis_pipeline import run_demo_pipeline, run_enhanced_pipeline_streamed
from tests.fakes import FakeModel, text_output, tool_call

DOCUMENT = "This Agreement is made between the parties hereto."
ERROR_MESSAGE = "An error occurred during analysis. Please try again."
MAX_TURNS_MESSAGE = (
    "The AI agent could not process this document within its turn "
    "limit. This usually means the document text could not be "
    "understood by the agent — please verify the file isn't "
    "corrupted, empty, or an unsupported format, and try again."
)
DEMO_ERROR_MESSAGE = (
    "Sorry, something went wrong during analysis. Please try uploading your document again."
)

DECISION = '{"action": "analyze_document", "reasoning": "A contract.", "confidence_score": 0.9}'
DETECTION = (
    '{"is_legal_document": true, "document_type": "contract",'
    ' "reasoning": "Clauses.", "confidence_score": 0.9}'
)
SUMMARY = '{"summary": "Short summary.", "key_points": []}'
FINAL_OUTPUT = (
    '{"summary": "Mutual NDA.", "verdict": "Safe.", "disclaimer": "Not advice.",'
    ' "confidence_score": 0.9, "processed_at": "2020-01-01T00:00:00",'
    ' "risks": [{"description": "Broad scope", "level": "HIGH", "category": "legal",'
    ' "recommendation": "Narrow it", "clause_reference": "Clause 2"}]}'
)


class FakeRedis:
    """In-memory stand-in for the Redis client boundary."""

    def __init__(self):
        self.store: dict[str, str] = {}

    async def get(self, key):
        return self.store.get(key)

    async def set(self, key, value, ex=None):
        self.store[key] = value


def main_turns():
    return [[tool_call("detect_document_type")], [text_output(DECISION)]]


def analysis_turns():
    return [[tool_call("summarize_document")], [text_output(FINAL_OUTPUT)]]


@pytest.fixture
def redis(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr(cache_manager, "client", fake)
    return fake


@pytest.fixture(autouse=True)
def no_delays(monkeypatch):
    real_sleep = asyncio.sleep

    async def instant(_delay, *args, **kwargs):
        await real_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", instant)


@pytest.fixture(autouse=True)
def working_sub_agents(monkeypatch):
    monkeypatch.setattr(
        document_detector_agent, "model", FakeModel([[text_output(DETECTION)]])
    )
    monkeypatch.setattr(summarizer_agent, "model", FakeModel([[text_output(SUMMARY)]]))
    monkeypatch.setattr(risk_detector_agent, "model", FakeModel([[text_output('{"risks": []}')]]))
    monkeypatch.setattr(clause_checker_agent, "model", FakeModel([[text_output("Fair.")]]))


def use_main_model(monkeypatch, turns):
    model = FakeModel(turns)
    monkeypatch.setattr(model_manager, "openai_model", model)
    return model


def happy_path_model(monkeypatch):
    return use_main_model(monkeypatch, main_turns() + analysis_turns())


async def run_enhanced(filename="first.txt", session_id="session-1", text=DOCUMENT):
    return [
        event
        async for event in run_enhanced_pipeline_streamed(text, filename, session_id)
    ]


def final_result(events):
    for event in events:
        payload = event.removeprefix("data: ").strip()
        if payload != "[DONE]" and "final_result" in json.loads(payload):
            return json.loads(payload)["final_result"]
    raise AssertionError("stream had no final_result")


def tool_called_on_every_attempt(name):
    # Then a plausible final output: under the SDK's default failure handling the
    # failed tool only feeds error text to the model, and the run finishes on this.
    return [[tool_call(name)]] * 3 + [[text_output(FINAL_OUTPUT)]]


async def test_failing_sub_agent_ends_in_error_and_caches_nothing(monkeypatch, redis):
    use_main_model(monkeypatch, main_turns() + tool_called_on_every_attempt("summarize_document"))
    monkeypatch.setattr(summarizer_agent, "model", FakeModel([RuntimeError("model down")]))

    events = await run_enhanced()

    result = final_result(events)
    assert result["type"] == "error"
    assert result["message"] == ERROR_MESSAGE
    assert redis.store == {}
    assert events[-1] == "data: [DONE]\n\n"


@pytest.mark.parametrize(
    "agent, tool_name",
    [(risk_detector_agent, "detect_risks"), (clause_checker_agent, "check_clause")],
)
async def test_other_analysis_tools_also_surface_sub_agent_failure(
    monkeypatch, redis, agent, tool_name
):
    use_main_model(monkeypatch, main_turns() + tool_called_on_every_attempt(tool_name))
    monkeypatch.setattr(agent, "model", FakeModel([RuntimeError("model down")]))

    result = final_result(await run_enhanced())

    assert result["type"] == "error"
    assert redis.store == {}


async def test_detection_tool_failure_stops_before_analysis(monkeypatch, redis):
    main_model = use_main_model(
        monkeypatch,
        [[tool_call("detect_document_type")]] * 3 + [[text_output(DECISION)]],
    )
    monkeypatch.setattr(document_detector_agent, "model", FakeModel([RuntimeError("model down")]))

    result = final_result(await run_enhanced())

    assert result["type"] == "error"
    assert len(main_model.inputs) == 3
    assert redis.store == {}


async def test_deterministic_sub_agent_failure_runs_once(monkeypatch, redis):
    use_main_model(monkeypatch, main_turns() + analysis_turns())
    summarizer_model = FakeModel([[text_output("not json")]])
    monkeypatch.setattr(summarizer_agent, "model", summarizer_model)

    result = final_result(await run_enhanced())

    assert result["type"] == "error"
    assert result["message"] == ERROR_MESSAGE
    assert len(summarizer_model.inputs) == 1


async def test_sub_agent_turn_limit_runs_once_with_the_turn_limit_message(monkeypatch, redis):
    use_main_model(monkeypatch, main_turns() + analysis_turns())
    monkeypatch.setattr(agent_factory, "SUB_AGENT_MAX_TURNS", 0)
    # Detection also runs a sub-agent, so the very first tool call hits the limit.
    detector_model = FakeModel([[text_output(DETECTION)]])
    monkeypatch.setattr(document_detector_agent, "model", detector_model)
    main_model = model_manager.openai_model

    result = final_result(await run_enhanced())

    assert result["type"] == "error"
    assert result["message"] == MAX_TURNS_MESSAGE
    assert len(main_model.inputs) == 1


async def test_transient_sub_agent_failure_retries_and_succeeds(monkeypatch, redis):
    use_main_model(
        monkeypatch,
        main_turns() + [[tool_call("summarize_document")]] + analysis_turns(),
    )
    summarizer_model = FakeModel([ConnectionError("blip"), [text_output(SUMMARY)]])
    monkeypatch.setattr(summarizer_agent, "model", summarizer_model)

    result = final_result(await run_enhanced())

    assert result["type"] == "legal_analysis"
    assert len(summarizer_model.inputs) == 2


async def test_transient_failure_gives_up_after_three_attempts(monkeypatch, redis):
    use_main_model(monkeypatch, main_turns() + [[tool_call("summarize_document")]])
    summarizer_model = FakeModel([ConnectionError("still down")])
    monkeypatch.setattr(summarizer_agent, "model", summarizer_model)

    result = final_result(await run_enhanced())

    assert result["type"] == "error"
    assert len(summarizer_model.inputs) == 3
    assert redis.store == {}


async def test_hit_shows_the_current_upload_and_stored_value_is_anonymous(monkeypatch, redis):
    happy_path_model(monkeypatch)
    first = final_result(await run_enhanced("alice-secret-deal.txt", "alice"))
    assert first["document_info"]["filename"] == "alice-secret-deal.txt"
    assert first["session_id"] == "alice"

    assert len(redis.store) == 1
    stored_text = next(iter(redis.store.values()))
    stored = json.loads(stored_text)
    assert "alice" not in stored_text
    assert "filename" not in stored["document_info"]
    assert "processed_at" not in stored["document_info"]
    assert "session_id" not in stored

    no_more_calls = use_main_model(monkeypatch, [RuntimeError("must not be called")])
    second = final_result(await run_enhanced("bob-copy.txt", "bob"))

    assert no_more_calls.inputs == []
    assert second["type"] == "legal_analysis"
    assert second["session_id"] == "bob"
    assert second["document_info"]["filename"] == "bob-copy.txt"
    assert second["document_info"]["processed_at"]
    assert second["document_info"]["word_count"] == 8
    assert second["document_info"]["estimated_pages"] == 1
    assert second["document_info"]["estimated_read_time"] == 1
    assert second["analysis"] == first["analysis"]
    assert second["analysis"]["risks"][0]["level"] == "high"
    assert second["friendly_message"] == "Analysis complete. Mutual NDA...."


async def test_empty_summary_message_never_stores_or_replays_the_old_filename(monkeypatch, redis):
    empty_summary = FINAL_OUTPUT.replace('"Mutual NDA."', '""')
    use_main_model(
        monkeypatch,
        main_turns() + [[tool_call("summarize_document")], [text_output(empty_summary)]],
    )
    await run_enhanced("alice-secret-deal.txt", "alice")

    assert "alice-secret-deal" not in next(iter(redis.store.values()))

    second = final_result(await run_enhanced("bob-copy.txt", "bob"))

    assert "bob-copy.txt" in second["friendly_message"]
    assert "alice-secret-deal" not in second["friendly_message"]


@pytest.mark.parametrize(
    "prompt_name",
    ["MAIN_AGENT_PROMPT", "ANALYSIS_AGENT_PROMPT", "SUMMARIZER_AGENT_PROMPT", "CLAUSE_AGENT_PROMPT"],
)
async def test_changed_prompt_misses(monkeypatch, redis, prompt_name):
    happy_path_model(monkeypatch)
    await run_enhanced()

    monkeypatch.setattr(agent_prompts, prompt_name, "A rewritten prompt.")
    model = happy_path_model(monkeypatch)
    await run_enhanced()

    assert len(model.inputs) == 4
    assert len(redis.store) == 2


async def test_changed_model_misses(monkeypatch, redis):
    happy_path_model(monkeypatch)
    await run_enhanced()

    monkeypatch.setattr(settings.openai, "model", "a-different-model")
    model = happy_path_model(monkeypatch)
    await run_enhanced()

    assert len(model.inputs) == 4
    assert len(redis.store) == 2


async def test_changed_sub_agent_default_model_misses(monkeypatch, redis):
    # Sub-agents set no model, so they run on the SDK default, not settings.openai.model.
    happy_path_model(monkeypatch)
    await run_enhanced()

    monkeypatch.setenv("OPENAI_DEFAULT_MODEL", "a-different-default")
    model = happy_path_model(monkeypatch)
    await run_enhanced()

    assert len(model.inputs) == 4
    assert len(redis.store) == 2


async def test_different_document_misses(monkeypatch, redis):
    happy_path_model(monkeypatch)
    await run_enhanced()

    model = happy_path_model(monkeypatch)
    await run_enhanced(text="A completely different lease agreement.")

    assert len(model.inputs) == 4


async def test_cache_key_is_sha256(monkeypatch, redis):
    happy_path_model(monkeypatch)
    await run_enhanced()

    # sha256 of DOCUMENT, computed independently.
    assert next(iter(redis.store)).endswith(
        ":" + "b271030284eaabd28338d05b1d0d8bc94d72903e686e4577ddba34a3778839e2"
    )


async def test_demo_shows_its_error_message_on_tool_failure(monkeypatch):
    monkeypatch.setattr(
        model_manager, "openrouter_model", FakeModel(main_turns() + analysis_turns())
    )
    monkeypatch.setattr(summarizer_agent, "model", FakeModel([RuntimeError("model down")]))

    events = [event async for event in run_demo_pipeline(DOCUMENT, "demo.txt", "demo")]
    payloads = [json.loads(e.removeprefix("data: ")) for e in events[:-1]]

    assert payloads[-1] == {"final_message": DEMO_ERROR_MESSAGE}
    assert not any("structured_data" in p for p in payloads)
    assert events[-1] == "data: [DONE]\n\n"
