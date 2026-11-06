"""Security guardrails for input validation and output safety."""

from agents import (
    input_guardrail,
    output_guardrail,
    RunContextWrapper,
    GuardrailFunctionOutput,
    Agent,
    TResponseInputItem,
)
from utils import logger
from schemas import FinalOutput, SharedContext, SensitiveCheckOutput
from infrastructure import model_manager
from .agent_prompts import GUARDRAIL_PROMPT
from .sub_agent_runner import run_sub_agent

# Single-shot, tool-less classifier — should resolve in 1 turn; small buffer only.
# (Not imported from agent_factory.py to avoid a circular import: agent_factory
# imports this module.)
GUARDRAIL_AGENT_MAX_TURNS = 3

# Create sensitive information checker agent
model_settings = model_manager.get_model_settings()
sensitive_check_agent = Agent(
    name="SensitiveInfoChecker",
    instructions=GUARDRAIL_PROMPT,
    output_type=SensitiveCheckOutput,
    model_settings=model_settings,
)


# Not parallel: the main model must not run on a document that will be blocked.
@input_guardrail(run_in_parallel=False)
async def sensitive_input_guardrail(
    ctx: RunContextWrapper[SharedContext],
    agent: Agent,
    input: str | list[TResponseInputItem],
) -> GuardrailFunctionOutput:
    """
    Guardrail to check input for sensitive information.

    Prevents processing of documents with high-risk personal data
    like credit cards, medical information, or credentials.
    """
    logger.logger.info("[GUARDRAIL] Checking for sensitive info...")

    if isinstance(input, list):
        user_inputs = [item["content"] for item in input if item["role"] == "user"]
        last_input = user_inputs[-1] if user_inputs else ""
    else:
        last_input = input

    result = await run_sub_agent(
        ctx, sensitive_check_agent, last_input, max_turns=GUARDRAIL_AGENT_MAX_TURNS
    )

    status = "BLOCKED" if result.final_output.contains_sensitive_info else "PASSED"
    logger.logger.info(f"[GUARDRAIL] Sensitive check result: {status}")

    return GuardrailFunctionOutput(
        output_info=result.final_output,
        tripwire_triggered=result.final_output.contains_sensitive_info,
    )


@output_guardrail
async def final_output_validation_guardrail(
    ctx: RunContextWrapper[SharedContext],
    agent: Agent,
    output: FinalOutput,
) -> GuardrailFunctionOutput:
    """
    Guardrail to validate final analysis output.

    Ensures output has required fields: summary, risks, verdict, disclaimer
    with minimum quality thresholds.
    """
    logger.logger.info("[GUARDRAIL] Validating final analysis output...")

    has_summary = bool(output.summary and len(output.summary.strip()) > 10)
    has_risks = output.risks is not None and isinstance(output.risks, list)
    has_verdict = bool(output.verdict and output.verdict.strip())
    has_disclaimer = bool(output.disclaimer and len(output.disclaimer.strip()) > 10)

    is_valid = has_summary and has_risks and has_verdict and has_disclaimer

    status_msg = (
        f"Summary: {'OK' if has_summary else 'MISSING'} | "
        f"Risks: {'OK' if has_risks else 'MISSING'} | "
        f"Verdict: {'OK' if has_verdict else 'MISSING'} | "
        f"Disclaimer: {'OK' if has_disclaimer else 'MISSING'} | "
        f"Result: {'VALID' if is_valid else 'INVALID'}"
    )
    logger.logger.info(f"[GUARDRAIL] Output validation: {status_msg}")

    return GuardrailFunctionOutput(
        output_info={
            "validation_passed": is_valid,
            "summary_valid": has_summary,
            "risks_valid": has_risks,
            "verdict_valid": has_verdict,
            "disclaimer_valid": has_disclaimer,
        },
        tripwire_triggered=not is_valid,
    )
