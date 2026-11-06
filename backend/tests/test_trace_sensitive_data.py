"""Document text must not reach traces, on any span, nested sub-agent runs included.

FakeModel opens no model spans, so these tests run the SDK's real model class
against a faked HTTP transport. That is the production path: the same code that
would fill a response span with the document runs here.
"""

import json

import httpx
import pytest
from agents import (
    AsyncOpenAI,
    OpenAIResponsesModel,
    TracingProcessor,
    set_trace_processors,
    set_tracing_disabled,
)
from agents.tracing.processors import default_processor

from infrastructure import model_manager
from services.analysis_pipeline import run_demo_pipeline, run_enhanced_pipeline_streamed
from tests.fakes import text_output, tool_call

MARKER = "ZEBRA-MARKER-7f3a91"
DOCUMENT = f"This Non-Disclosure Agreement binds Acme and Beta. Secret clause: {MARKER}."

CLEAN_JSON = json.dumps({"contains_sensitive_info": False, "reasoning": "Nothing flagged."})
DETECTOR_JSON = json.dumps(
    {
        "is_legal_document": True,
        "document_type": "NDA",
        "reasoning": f"It quotes {MARKER}.",
        "confidence_score": 0.9,
    }
)
DECISION_JSON = json.dumps({"action": "analyze_document", "reasoning": "Legal document."})
SUMMARY_JSON = json.dumps({"summary": f"Quotes {MARKER}.", "key_points": ["Mutual"]})
RISKS_JSON = json.dumps({"risks": [], "overall_risk_level": "low"})
FINAL_JSON = json.dumps({"summary": f"Quotes {MARKER}.", "risks": [], "verdict": "safe"})

SCRIPTED_TURNS = [
    text_output(CLEAN_JSON),
    tool_call("detect_document_type"),
    text_output(DETECTOR_JSON),
    text_output(DECISION_JSON),
    tool_call("summarize_document"),
    text_output(SUMMARY_JSON),
    tool_call("detect_risks"),
    text_output(RISKS_JSON),
    tool_call("check_clause"),
    text_output(f"Clause {MARKER} looks fair."),
    text_output(FINAL_JSON),
]


def scripted_responses_model() -> OpenAIResponsesModel:
    """The real Responses model, with only the OpenAI HTTP endpoint replaced."""
    turns = iter(SCRIPTED_TURNS)

    def respond(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "resp_fake",
                "object": "response",
                "created_at": 0,
                "model": "fake",
                "output": [next(turns).model_dump()],
                "parallel_tool_calls": False,
                "tool_choice": "auto",
                "tools": [],
                "usage": {
                    "input_tokens": 1,
                    "output_tokens": 1,
                    "total_tokens": 2,
                    "input_tokens_details": {"cached_tokens": 0},
                    "output_tokens_details": {"reasoning_tokens": 0},
                },
            },
        )

    client = AsyncOpenAI(
        api_key="test-key",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)),
    )
    return OpenAIResponsesModel(model="fake", openai_client=client)


class CapturingProcessor(TracingProcessor):
    def __init__(self):
        self.traces = []
        self.spans = []

    def on_trace_start(self, trace):
        self.traces.append(trace)

    def on_trace_end(self, trace):
        pass

    def on_span_start(self, span):
        pass

    def on_span_end(self, span):
        self.spans.append(span)

    def shutdown(self):
        pass

    def force_flush(self):
        pass


def everything_recorded(span) -> str:
    """What the OpenAI exporter sends, plus what other trace processors could read."""
    data = span.span_data
    return json.dumps(
        [
            span.export(),
            getattr(data, "input", None),
            getattr(data, "response", None) and data.response.model_dump(),
        ],
        default=str,
    )


@pytest.fixture
def captured():
    """Tracing on, with the capturing processor as the only one so nothing is uploaded."""
    processor = CapturingProcessor()
    set_trace_processors([processor])
    set_tracing_disabled(False)
    yield processor
    set_tracing_disabled(True)
    set_trace_processors([default_processor()])


@pytest.fixture(autouse=True)
def no_pipeline_delays(monkeypatch):
    async def instant(_seconds):
        return None

    monkeypatch.setattr("services.analysis_pipeline.asyncio.sleep", instant)


@pytest.fixture
def enhanced_run_events(monkeypatch, captured):
    monkeypatch.setattr(model_manager, "openai_model", scripted_responses_model())

    async def run():
        return [
            e async for e in run_enhanced_pipeline_streamed(DOCUMENT, "nda.txt", "session-trace")
        ]

    return run


async def test_enhanced_pipeline_keeps_tracing_every_step_including_sub_agents(
    enhanced_run_events, captured
):
    events = await enhanced_run_events()

    assert any("legal_analysis" in e for e in events)
    assert len(captured.traces) == 2
    spans_by_type = {}
    for span in captured.spans:
        spans_by_type.setdefault(span.span_data.type, []).append(span)
    assert len(spans_by_type["response"]) == 11
    assert len(spans_by_type["function"]) == 4
    assert len(spans_by_type["agent"]) == 7

    by_id = {s.span_id: s for s in captured.spans}

    def runs_inside_a_tool(span) -> bool:
        parent = by_id.get(span.parent_id)
        while parent is not None:
            if parent.span_data.type == "function":
                return True
            parent = by_id.get(parent.parent_id)
        return False

    assert sum(runs_inside_a_tool(s) for s in spans_by_type["response"]) == 4


async def test_enhanced_pipeline_keeps_document_text_out_of_every_span(
    enhanced_run_events, captured
):
    await enhanced_run_events()

    leaks = [s.span_data.type for s in captured.spans if MARKER in everything_recorded(s)]
    assert leaks == []
    assert not any(MARKER in json.dumps(t.export(), default=str) for t in captured.traces)


async def test_demo_pipeline_creates_no_spans_at_all(monkeypatch, captured):
    monkeypatch.setattr(model_manager, "openrouter_model", scripted_responses_model())

    events = [e async for e in run_demo_pipeline(DOCUMENT, "nda.txt", "session-demo")]

    assert any("structured_data" in e for e in events)
    assert captured.spans == []
    assert captured.traces == []
