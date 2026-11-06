"""Runs a sub-agent as part of the outer agent run that invoked it."""

from typing import Any

from agents import Agent, RunContextWrapper, RunResult, Runner
from schemas import SharedContext


async def run_sub_agent(
    ctx: RunContextWrapper[SharedContext], agent: Agent, input: Any, max_turns: int
) -> RunResult:
    """Run `agent` on the outer run's config and add its tokens to the outer run's usage.

    A nested Runner.run inherits neither: without a run_config it falls back to
    the SDK's default model, and it tracks usage in its own context wrapper.
    """
    result = await Runner.run(
        agent,
        input,
        run_config=ctx.context.run_config,
        context=ctx.context,
        max_turns=max_turns,
    )
    ctx.usage.add(result.context_wrapper.usage)
    return result
