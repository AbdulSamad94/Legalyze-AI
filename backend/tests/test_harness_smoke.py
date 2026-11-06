"""Proves the harness can drive real project code offline."""

import pytest
from agents import Agent, RunConfig, Runner, function_tool

from services.analysis_pipeline import get_document_insights
from tests.fakes import FakeModel, text_output, tool_call
from utils import RetryConfig, RetryHandler


def test_document_insights_counts_a_known_document():
    insights = get_document_insights("word " * 500)

    assert insights["word_count"] == 500
    assert insights["estimated_pages"] == 2
    assert insights["estimated_read_time"] == 2


async def test_retry_handler_does_not_retry_non_retryable_errors():
    attempts = 0

    async def always_fails():
        nonlocal attempts
        attempts += 1
        raise ValueError("deterministic failure")

    with pytest.raises(ValueError):
        await RetryHandler.execute(
            always_fails,
            config=RetryConfig(max_attempts=3, initial_delay=0, non_retryable=(ValueError,)),
        )

    assert attempts == 1


async def test_fake_model_drives_the_real_runner_through_a_tool_call():
    @function_tool(name_override="ping")
    async def ping() -> str:
        return "pong"

    model = FakeModel([[tool_call("ping")], [text_output("done")]])
    agent = Agent(name="smoke", instructions="test", tools=[ping])

    result = await Runner.run(
        agent, "hello", run_config=RunConfig(model=model, tracing_disabled=True)
    )

    assert result.final_output == "done"
    assert result.context_wrapper.usage.total_tokens == 200
