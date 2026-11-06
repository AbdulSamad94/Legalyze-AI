"""Factory for creating configured agents with tools and guardrails."""

from agents import Agent, RunContextWrapper, Runner, enable_verbose_stdout_logging, function_tool
from schemas import FinalOutput, AgentDecision, SharedContext
from infrastructure import model_manager
from .agent_prompts import ANALYSIS_AGENT_PROMPT, MAIN_AGENT_PROMPT
from .agent_definitions import (
    summarizer_agent,
    risk_detector_agent,
    clause_checker_agent,
    document_detector_agent,
)
from .guardrails import (
    sensitive_input_guardrail,
    final_output_validation_guardrail,
)

enable_verbose_stdout_logging()


# --- max_turns budgets ---
# `max_turns` is a Runner.run() parameter (not an Agent(...) field) in
# openai-agents 0.17.7 — verified against the installed SDK and the official docs.
# Each sub-agent below is a single-shot, tool-less classifier/generator, so it
# should resolve in 1 turn under normal conditions; a small buffer covers minor
# self-correction without allowing runaway retries on bad input.
SUB_AGENT_MAX_TURNS = 3

# The main routing agent makes exactly one tool call (detect_document_type) then
# produces its AgentDecision: 1 turn to call the tool, 1 to receive the result,
# 1 for the final structured decision, +buffer.
MAIN_AGENT_MAX_TURNS = 6

# The analysis agent calls up to three tools sequentially (summarize, detect_risks,
# check_clause) and then synthesizes FinalOutput: ~2 turns per tool round-trip
# plus a final synthesis turn, +buffer.
ANALYSIS_AGENT_MAX_TURNS = 10


# --- Function-tool wrappers instead of `.as_tool()` ---
#
# `.as_tool()`'s default schema (`AgentAsToolInput`) is `{"input": str}` — it
# requires the CALLING agent's LLM to transcribe the entire document text
# verbatim as a JSON tool-call argument, generated within that agent's own
# `max_tokens` output budget (1000). Any document long enough to exceed that
# budget gets a truncated, invalid JSON argument every time — this was the
# real root cause of "Invalid JSON input for tool X" on real (non-garbage)
# documents, confirmed via a live OpenAI trace on a real ~1600-token document.
#
# Fix: these are plain function tools that take no document-text argument at
# all. They read the real text directly from `ctx.context.document_text`
# (the same `SharedContext` already passed into `Runner.run(..., context=...)`),
# so the calling agent never has to generate more than an empty/trivial
# argument, and there is nothing for a truncated generation to corrupt.


@function_tool(
    name_override="detect_document_type",
    description_override="Detects document type and classifies if it's a legal document.",
    failure_error_function=None,
)
async def detect_document_type_tool(ctx: RunContextWrapper[SharedContext]) -> str:
    result = await Runner.run(
        document_detector_agent, ctx.context.document_text, max_turns=SUB_AGENT_MAX_TURNS
    )
    return result.final_output.model_dump_json()


@function_tool(
    name_override="summarize_document",
    description_override="Summarizes the legal document with key points and business implications.",
    failure_error_function=None,
)
async def summarize_document_tool(ctx: RunContextWrapper[SharedContext]) -> str:
    result = await Runner.run(
        summarizer_agent, ctx.context.document_text, max_turns=SUB_AGENT_MAX_TURNS
    )
    return result.final_output.model_dump_json()


@function_tool(
    name_override="detect_risks",
    description_override="Identifies legal and business risks in the document.",
    failure_error_function=None,
)
async def detect_risks_tool(ctx: RunContextWrapper[SharedContext]) -> str:
    result = await Runner.run(
        risk_detector_agent, ctx.context.document_text, max_turns=SUB_AGENT_MAX_TURNS
    )
    return result.final_output.model_dump_json()


@function_tool(
    name_override="check_clause",
    description_override="Analyzes specific contract clauses for fairness and clarity.",
    failure_error_function=None,
)
async def check_clause_tool(ctx: RunContextWrapper[SharedContext]) -> str:
    result = await Runner.run(
        clause_checker_agent, ctx.context.document_text, max_turns=SUB_AGENT_MAX_TURNS
    )
    return str(result.final_output)


def create_analysis_agent() -> Agent[SharedContext]:
    """
    Create and configure the main analysis agent.

    The analysis agent uses specialized sub-agents as tools to:
    - Summarize documents
    - Detect risks
    - Check specific clauses

    Must be run with `context=` set to a `SharedContext` so its tools can read
    `ctx.context.document_text` (see function-tool wrappers above).

    Its own final output (FinalOutput: summary + risk list + verdict +
    disclaimer, all in one JSON payload) is the single largest structured
    output in the whole pipeline — confirmed truncating mid-JSON at the
    default max_tokens=1000 on a real ~5,600-char document, so it gets the
    largest explicit budget of any agent here.
    """
    model_settings = model_manager.get_model_settings(max_tokens=6144)

    return Agent(
        name="LegalAnalysisAgent",
        instructions=ANALYSIS_AGENT_PROMPT,
        output_type=FinalOutput,
        tools=[
            summarize_document_tool,
            detect_risks_tool,
            check_clause_tool,
        ],
        model_settings=model_settings,
    )


def create_main_agent() -> Agent[SharedContext]:
    """
    Create and configure the routing agent.

    The main agent decides whether input is a legal document
    and routes it appropriately for analysis.

    Must be run with `context=` set to a `SharedContext` so its tool can read
    `ctx.context.document_text` (see function-tool wrappers above).
    """
    model_settings = model_manager.get_model_settings()

    return Agent(
        name="MainLegalAgent",
        instructions=MAIN_AGENT_PROMPT,
        output_type=AgentDecision,
        tools=[detect_document_type_tool],
        model_settings=model_settings,
    )


# Global agent instances
analysis_agent = create_analysis_agent()
main_agent = create_main_agent()
