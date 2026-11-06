"""Sub-agents must run on the outer run's model and count towards its usage."""

import json
import logging

import pytest
from agents import RunConfig, Runner

from core.agent_factory import analysis_agent, main_agent
from infrastructure import model_manager
from schemas import SharedContext
from services.analysis_pipeline import run_demo_pipeline, run_enhanced_pipeline_streamed
from tests.fakes import FakeModel, text_output, tool_call

DOCUMENT = "This Non-Disclosure Agreement is made between Acme and Beta."

DETECTOR_JSON = json.dumps(
    {
        "is_legal_document": True,
        "document_type": "NDA-from-sub-agent",
        "reasoning": "It is an NDA.",
        "confidence_score": 0.9,
    }
)
DECISION_JSON = json.dumps({"action": "analyze_document", "reasoning": "Legal document."})
SUMMARY_JSON = json.dumps({"summary": "A short NDA.", "key_points": ["Mutual"]})
RISKS_JSON = json.dumps({"risks": [], "overall_risk_level": "low"})
FINAL_JSON = json.dumps({"summary": "A short NDA.", "risks": [], "verdict": "safe"})


def main_agent_turns() -> list:
    return [
        [tool_call("detect_document_type")],
        [text_output(DETECTOR_JSON)],
        [text_output(DECISION_JSON)],
    ]


def analysis_agent_turns() -> list:
    return [
        [tool_call("summarize_document")],
        [text_output(SUMMARY_JSON)],
        [tool_call("detect_risks")],
        [text_output(RISKS_JSON)],
        [tool_call("check_clause")],
        [text_output("Clauses look fair.")],
        [text_output(FINAL_JSON)],
    ]


def full_pipeline_model() -> FakeModel:
    return FakeModel(main_agent_turns() + analysis_agent_turns())


def unused_model() -> FakeModel:
    return FakeModel([RuntimeError("this model must not be called")])


@pytest.fixture
def no_pipeline_delays(monkeypatch):
    async def instant(_seconds):
        return None

    monkeypatch.setattr("services.analysis_pipeline.asyncio.sleep", instant)


async def run_main_agent(model: FakeModel):
    config = RunConfig(model=model, tracing_disabled=True)
    context = SharedContext(document_text=DOCUMENT, run_config=config)
    return await Runner.run(main_agent, DOCUMENT, run_config=config, context=context)


async def test_sub_agent_runs_on_the_outer_runs_model():
    model = FakeModel(main_agent_turns())

    await run_main_agent(model)

    assert len(model.inputs) == 3
    assert model.inputs[1] == [{"content": DOCUMENT, "role": "user"}]
    assert "NDA-from-sub-agent" in json.dumps(model.inputs[2], default=str)


async def test_total_tokens_include_the_sub_agents_tokens():
    result = await run_main_agent(FakeModel(main_agent_turns()))

    assert result.context_wrapper.usage.total_tokens == 300


async def test_analysis_agent_tokens_include_all_three_sub_agents():
    model = FakeModel(analysis_agent_turns())
    config = RunConfig(model=model, tracing_disabled=True)
    context = SharedContext(document_text=DOCUMENT, run_config=config)

    result = await Runner.run(
        analysis_agent, DOCUMENT, run_config=config, context=context, max_turns=10
    )

    assert result.context_wrapper.usage.total_tokens == 700


def test_shared_context_keeps_the_config_out_of_serialized_output():
    config = RunConfig(model=unused_model())

    context = SharedContext(document_text=DOCUMENT, run_config=config)

    assert context.run_config is config
    assert "run_config" not in context.model_dump()
    assert "run_config" not in json.loads(context.model_dump_json())


async def test_demo_pipeline_sends_every_call_to_the_openrouter_model(
    monkeypatch, no_pipeline_delays
):
    openrouter = full_pipeline_model()
    openai = unused_model()
    monkeypatch.setattr(model_manager, "openrouter_model", openrouter)
    monkeypatch.setattr(model_manager, "openai_model", openai)

    events = [e async for e in run_demo_pipeline(DOCUMENT, "nda.txt", "session-demo")]

    assert len(openrouter.inputs) == 10
    assert openai.inputs == []
    assert any("structured_data" in e for e in events)


async def test_enhanced_pipeline_uses_the_openai_model_and_logs_all_tokens(
    monkeypatch, caplog, no_pipeline_delays
):
    openai = full_pipeline_model()
    openrouter = unused_model()
    monkeypatch.setattr(model_manager, "openai_model", openai)
    monkeypatch.setattr(model_manager, "openrouter_model", openrouter)

    with caplog.at_level(logging.INFO, logger="legalyze-ai"):
        events = [
            e async for e in run_enhanced_pipeline_streamed(DOCUMENT, "nda.txt", "session-full")
        ]

    assert len(openai.inputs) == 10
    assert openrouter.inputs == []
    assert any("final_result" in e and "legal_analysis" in e for e in events)
    assert "tokens=1000," in caplog.text
