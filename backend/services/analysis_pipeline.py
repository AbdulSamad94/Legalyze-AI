import asyncio
import json
import time
from typing import AsyncGenerator, Dict, Any
from datetime import datetime

from agents import (
    Runner,
    RunConfig,
    InputGuardrailTripwireTriggered,
    OutputGuardrailTripwireTriggered,
    MaxTurnsExceeded,
    ModelBehaviorError,
)
from schemas import SharedContext, AgentDecision
from infrastructure import model_manager
from core.untrusted_document import wrap_untrusted_document
from core.agent_factory import (
    analysis_agent,
    main_agent,
    MAIN_AGENT_MAX_TURNS,
    ANALYSIS_AGENT_MAX_TURNS,
)
from utils import logger
from infrastructure import cache_manager
from utils.metrics import metrics
from utils import RetryHandler, RetryConfig

# Agent-run retries: only retry genuinely transient failures (rate limits, network
# blips). MaxTurnsExceeded/ModelBehaviorError/guardrail trips are deterministic —
# the same (bad) input will fail the same way every time, so retrying just
# multiplies wasted LLM turns instead of fixing anything. See AUDIT.md M1/C1/C2
# history and the docx-extraction incident this config was introduced to fix.
AGENT_RETRY = RetryConfig(
    max_attempts=3,
    initial_delay=1.0,
    max_delay=30.0,
    non_retryable=(
        MaxTurnsExceeded,
        ModelBehaviorError,
        InputGuardrailTripwireTriggered,
        OutputGuardrailTripwireTriggered,
    ),
)


def estimate_processing_time(text_length: int) -> int:
    """Estimate processing time in seconds based on text length"""
    if text_length < 1000:
        return 15
    elif text_length < 5000:
        return 30
    elif text_length < 10000:
        return 45
    else:
        return 60


def _without_whitespace(text: str) -> str:
    return "".join(text.split()).casefold()


def is_quoted_in_document(quote: str, document: str) -> bool:
    """Whether `quote` appears in `document`, ignoring whitespace and case."""
    needle = _without_whitespace(quote)
    return bool(needle) and needle in _without_whitespace(document)


def get_document_insights(text: str) -> Dict[str, Any]:
    """Extract basic document insights"""
    word_count = len(text.split())
    char_count = len(text)
    estimated_pages = max(1, word_count // 250)

    return {
        "word_count": word_count,
        "character_count": char_count,
        "estimated_pages": estimated_pages,
        "estimated_read_time": max(1, word_count // 200),
    }


async def run_demo_pipeline(
    user_text: str, filename: str, session_id: str
) -> AsyncGenerator[str, None]:
    """Simplified demo pipeline with basic analysis - FIXED VERSION"""

    config = RunConfig(
        tracing_disabled=True,
        model=model_manager.get_openrouter_model(),
        model_provider=None,
    )

    def create_status_message(step: str, status: str, message: str) -> str:
        """Helper to format the data for SSE."""
        payload = json.dumps({"step": step, "status": status, "message": message})
        return f"data: {payload}\n\n"

    try:
        # Step 1: Document recieved
        yield create_status_message(
            "Document Processing",
            "completed",
            f"Successfully received '{filename}' ({len(user_text)} characters)",
        )
        await asyncio.sleep(0.5)

        # Step 2: Text extract
        word_count = len(user_text.split())
        yield create_status_message(
            "Text Extraction",
            "completed",
            f"Extracted {word_count} words from document",
        )
        await asyncio.sleep(0.5)

        context = SharedContext(document_text=user_text, analysis_stage="starting", run_config=config)

        # Step 3: Document tpye detect
        yield create_status_message(
            "Document Analysis",
            "processing",
            "Analyzing document type and structure...",
        )

        decision_result = await Runner.run(
            main_agent,
            wrap_untrusted_document(user_text),
            run_config=config,
            context=context,
            max_turns=MAIN_AGENT_MAX_TURNS,
        )
        decision: AgentDecision = decision_result.final_output

        yield create_status_message(
            "Document Analysis",
            "completed",
            f"Document type identified: {decision.action.replace('_', ' ').title()}",
        )
        await asyncio.sleep(0.5)

        # Step 4: Process based on agents decision
        final_message = ""

        if decision.action == "analyze_document":
            yield create_status_message(
                "AI Analysis",
                "processing",
                "Running comprehensive legal analysis...",
            )

            # Run the analysis agent (context= required so its tools can read
            # ctx.context.document_text instead of the model transcribing it)
            analysis_output = await Runner.run(
                analysis_agent,
                wrap_untrusted_document(user_text),
                run_config=config,
                context=context,
                max_turns=ANALYSIS_AGENT_MAX_TURNS,
            )

            yield create_status_message(
                "AI Analysis",
                "completed",
                "Legal analysis completed successfully",
            )
            await asyncio.sleep(0.5)

            # Generate friendly response
            yield create_status_message(
                "Report Generation",
                "processing",
                "Creating your personalized report...",
            )

            # Convert analysis to dictionaar
            try:
                if hasattr(analysis_output.final_output, "model_dump"):
                    analysis_dict = analysis_output.final_output.model_dump()
                else:
                    analysis_dict = {
                        "summary": getattr(analysis_output.final_output, "summary", ""),
                        "risks": getattr(analysis_output.final_output, "risks", []),
                        "verdict": getattr(analysis_output.final_output, "verdict", ""),
                        "disclaimer": getattr(
                            analysis_output.final_output, "disclaimer", ""
                        ),
                        "confidence_score": getattr(
                            analysis_output.final_output, "confidence_score", 0.8
                        ),
                    }

                # Normalizee the risks
                normalized_risks = []
                risks = analysis_dict.get("risks", [])
                for r in risks:
                    try:
                        rd = r.model_dump() if hasattr(r, "model_dump") else dict(r)
                    except Exception:
                        rd = r if isinstance(r, dict) else {}

                    normalized_risks.append(
                        {
                            "description": str(rd.get("description", "")),
                            "level": str(rd.get("level", "unknown")).lower(),
                            "category": str(rd.get("category", "")),
                            "recommendation": str(rd.get("recommendation", "")),
                        }
                    )

                final_structured_data = {
                    "summary": analysis_dict.get("summary", ""),
                    "risks": normalized_risks,
                    "verdict": analysis_dict.get("verdict", ""),
                    "disclaimer": analysis_dict.get("disclaimer", ""),
                    "risk_count": len(normalized_risks),
                    "confidence_score": analysis_dict.get("confidence_score", 0.8),
                }

            except Exception as e:
                logger.analysis_error(session_id, f"Analysis processing failed: {str(e)}", "ANALYSIS_ERROR")
                final_structured_data = {
                    "summary": "Document analysis completed but some details could not be extracted.",
                    "risks": [],
                    "verdict": "Please review the document manually for potential issues.",
                    "disclaimer": "This analysis is for informational purposes only and does not constitute legal advice.",
                    "risk_count": 0,
                    "confidence_score": 0.5,
                }

            yield create_status_message(
                "Report Generation",
                "completed",
                "Your analysis report is ready!",
            )
        else:
            final_message = """I couldn't identify this as a legal document. 

            Please upload a clear legal document such as:
            - Contracts and agreements
            - NDAs and confidentiality agreements  
            - Terms of service
            - Privacy policies
            - Legal notices

            Or feel free to ask me any general legal questions!"""

            yield create_status_message(
                "Processing Complete",
                "completed",
                "Analysis finished - document type unclear",
            )

        # Send structured data for proper rendering
        if decision.action == "analyze_document":
            final_payload = json.dumps({"structured_data": final_structured_data})
        else:
            final_payload = json.dumps({"final_message": final_message})
        yield f"data: {final_payload}\n\n"

    except MaxTurnsExceeded as e:
        error_message = (
            "The AI agent could not process this document within its turn limit. "
            "This usually means the document text could not be understood — "
            "please verify the file isn't corrupted and try again."
        )
        logger.logger.error(f"[DEMO] Max turns exceeded: {str(e)}")
        yield create_status_message("Analysis Failed", "failed", error_message)

        final_payload = json.dumps({"final_message": error_message})
        yield f"data: {final_payload}\n\n"

    except InputGuardrailTripwireTriggered as e:
        error_message = "This document contains sensitive information that cannot be processed for security reasons."
        yield create_status_message("Security Check", "failed", error_message)

        final_payload = json.dumps({"final_message": error_message})
        yield f"data: {final_payload}\n\n"

    except OutputGuardrailTripwireTriggered as e:
        error_message = "Analysis output validation failed. Please try again with a different document."
        yield create_status_message("Validation Check", "failed", error_message)

        final_payload = json.dumps({"final_message": error_message})
        yield f"data: {final_payload}\n\n"

    except Exception as e:
        logger.analysis_error(session_id, f"Demo pipeline failed: {str(e)}", "DEMO_ERROR")
        error_message = "Sorry, something went wrong during analysis. Please try uploading your document again."
        yield create_status_message("System Error", "failed", error_message)

        final_payload = json.dumps({"final_message": error_message})
        yield f"data: {final_payload}\n\n"

    yield "data: [DONE]\n\n"


async def run_enhanced_pipeline_streamed(
    user_text: str, filename: str, session_id: str
) -> AsyncGenerator[str, None]:
    """Enhanced pipeline with caching and retry logic."""
    config = RunConfig(tracing_disabled=False, model=model_manager.get_openai_model(), model_provider=None)

    # Initialize cache connection
    await cache_manager.connect()

    # Start timing
    start_time = time.time()

    # Log analysis started
    metrics.log_analysis_started(session_id, len(user_text), "legal_document")

    def create_status_message(
        step: str,
        status: str,
        message: str,
        progress: int = 0,
        details: Dict[str, Any] = None,
    ) -> str:
        """Enhanced status message with progress and details"""
        payload = {
            "step": step,
            "status": status,
            "message": message,
            "progress": progress,
            "timestamp": datetime.now().isoformat(),
            "details": details or {},
        }
        return f"data: {json.dumps(payload, default=str)}\n\n"

    try:
        document_insights = get_document_insights(user_text)
        estimated_time = estimate_processing_time(len(user_text))

        yield create_status_message(
            "Document Received",
            "completed",
            f"Successfully processed your document '{filename}'",
            10,
            {
                "filename": filename,
                "word_count": document_insights["word_count"],
                "estimated_pages": document_insights["estimated_pages"],
                "estimated_time": estimated_time,
            },
        )
        await asyncio.sleep(1)

        yield create_status_message(
            "Text Extraction",
            "completed",
            f"Extracted {document_insights['word_count']} words from {document_insights['estimated_pages']} pages",
            20,
            document_insights,
        )
        await asyncio.sleep(1)

        context = SharedContext(document_text=user_text, analysis_stage="starting", run_config=config)

        # Check cache first for this document
        cached_result = await cache_manager.get(user_text)
        if cached_result:
            metrics.log_cache_hit(session_id)
            yield create_status_message(
                "Cache Hit",
                "completed",
                "Found cached analysis result, retrieving...",
                30,
            )
            # Use cached result and skip to report generation
            final_result = cached_result
            yield create_status_message(
                "Report Ready",
                "completed",
                "Retrieved cached analysis!",
                100,
            )
            yield f"data: {json.dumps({'final_result': final_result}, default=str)}\n\n"
            yield "data: [DONE]\n\n"
            metrics.log_analysis_completed(session_id, time.time() - start_time, 0, cache_hit=True)
            return

        metrics.log_cache_miss(session_id)

        yield create_status_message(
            "Document Classification",
            "processing",
            "Analyzing document type and structure...",
            30,
        )

        # Run with retry for resilience (transient failures only — see AGENT_RETRY)
        decision_result = await RetryHandler.execute(
            lambda: Runner.run(
                main_agent,
                wrap_untrusted_document(user_text),
                run_config=config,
                context=context,
                max_turns=MAIN_AGENT_MAX_TURNS,
            ),
            config=AGENT_RETRY,
            op_name="main_agent classification",
        )
        decision: AgentDecision = decision_result.final_output
        metrics.log_pipeline_step(session_id, "document_classification", "completed")

        yield create_status_message(
            "Document Classification",
            "completed",
            f"Identified as: {decision.action.replace('_', ' ').title()}",
            40,
            {"decision": decision.action, "reasoning": decision.reasoning},
        )
        await asyncio.sleep(1)

        if decision.action == "analyze_document":
            yield create_status_message(
                "AI Analysis",
                "processing",
                "Our AI legal experts are analyzing your document...",
                50,
            )
            # Run analysis with retry for resilience (transient failures only — see AGENT_RETRY)
            # context= required so its tools can read ctx.context.document_text
            # instead of the model transcribing the whole document as a tool arg
            analysis_output = await RetryHandler.execute(
                lambda: Runner.run(
                    analysis_agent,
                    wrap_untrusted_document(user_text),
                    run_config=config,
                    context=context,
                    max_turns=ANALYSIS_AGENT_MAX_TURNS,
                ),
                config=AGENT_RETRY,
                op_name="analysis_agent run",
            )
            metrics.log_pipeline_step(session_id, "analysis", "completed")

            yield create_status_message(
                "AI Analysis",
                "completed",
                "Document analysis completed successfully",
                80,
                {
                    "risks_found": (
                        len(analysis_output.final_output.risks)
                        if analysis_output.final_output.risks
                        else 0
                    ),
                    "summary_length": len(analysis_output.final_output.summary.split()),
                },
            )
            await asyncio.sleep(1)

            yield create_status_message(
                "Generating Report",
                "processing",
                "Creating your personalized legal analysis report...",
                90,
            )

            try:
                analysis_dict = (
                    analysis_output.final_output.model_dump()
                    if hasattr(analysis_output.final_output, "model_dump")
                    else dict(analysis_output.final_output)
                )
            except Exception:
                analysis_dict = {
                    "summary": getattr(analysis_output.final_output, "summary", ""),
                    "risks": getattr(analysis_output.final_output, "risks", []),
                    "verdict": getattr(analysis_output.final_output, "verdict", ""),
                    "disclaimer": getattr(
                        analysis_output.final_output, "disclaimer", ""
                    ),
                    "confidence_score": getattr(
                        analysis_output.final_output, "confidence_score", 0.8
                    ),
                    "processed_at": getattr(
                        analysis_output.final_output,
                        "processed_at",
                        datetime.now().isoformat(),
                    ),
                }

            normalized_risks = []
            cleared_clauses = 0
            for r in analysis_dict.get("risks", []):
                try:
                    rd = r.model_dump() if hasattr(r, "model_dump") else dict(r)
                except Exception:
                    rd = r if isinstance(r, dict) else {}

                norm = {
                    "description": str(rd.get("description", "")),
                    "level": str(rd.get("level", "unknown")).lower(),
                    "category": str(rd.get("category", "")),
                    "recommendation": str(rd.get("recommendation", "")),
                    "clause_reference": str(rd.get("clause_reference", "")),
                }
                if norm["clause_reference"] and not is_quoted_in_document(
                    norm["clause_reference"], user_text
                ):
                    norm["clause_reference"] = ""
                    cleared_clauses += 1
                normalized_risks.append(norm)

            if cleared_clauses:
                logger.logger.warning(
                    f"[CLAUSES] session={session_id}, cleared {cleared_clauses} "
                    "clause references not found in the document"
                )

            analysis_dict["risks"] = normalized_risks

            friendly_message = f"Your analysis for '{filename}' is complete. Here is a summary of our findings, key risks identified, and our final verdict."
            if summary := analysis_dict.get("summary"):
                friendly_message = f"Analysis complete. {summary[:250]}..."

            final_result = {
                "type": "legal_analysis",
                "document_info": {
                    "filename": filename,
                    "word_count": get_document_insights(user_text).get("word_count"),
                    "estimated_pages": get_document_insights(user_text).get(
                        "estimated_pages"
                    ),
                    "estimated_read_time": get_document_insights(user_text).get(
                        "estimated_read_time"
                    ),
                    "processed_at": datetime.now().isoformat(),
                },
                "analysis": {
                    "summary": analysis_dict.get("summary", ""),
                    "risks": analysis_dict.get("risks", []),
                    "verdict": analysis_dict.get("verdict", ""),
                    "disclaimer": analysis_dict.get("disclaimer", ""),
                },
                "friendly_message": friendly_message,
                "session_id": session_id,
            }

            # Cache the result for future identical documents
            await cache_manager.set(user_text, final_result)
            metrics.log_pipeline_step(session_id, "caching", "completed")

            # Calculate processing time and total token usage across both agent runs
            processing_time = time.time() - start_time
            risks_count = len(final_result.get("analysis", {}).get("risks", []))
            tokens_used = (
                decision_result.context_wrapper.usage.total_tokens
                + analysis_output.context_wrapper.usage.total_tokens
            )
            metrics.log_analysis_completed(
                session_id, processing_time, risks_count, tokens_used=tokens_used
            )

            yield create_status_message(
                "Report Ready",
                "completed",
                "Your legal analysis report is ready!",
                100,
                {"session_id": session_id},
            )

            yield f"data: {json.dumps({'final_result': final_result}, default=str)}\n\n"

        else:  # This handles 'no_document_found'
            final_result = {
                "type": "error",
                "message": "This does not appear to be a legal document suitable for analysis. Please upload a clear contract, agreement, or policy. Alternatively, you can ask a general legal question.",
                "session_id": session_id,
            }
            yield create_status_message(
                "Analysis Halted", "completed", "Unsupported document type", 100
            )
            yield f"data: {json.dumps({'final_result': final_result})}\n\n"

    except MaxTurnsExceeded as e:
        error_result = {
            "type": "error",
            "message": (
                "The AI agent could not process this document within its turn "
                "limit. This usually means the document text could not be "
                "understood by the agent — please verify the file isn't "
                "corrupted, empty, or an unsupported format, and try again."
            ),
            "session_id": session_id,
        }
        processing_time = time.time() - start_time
        metrics.log_analysis_error(session_id, str(e), "max_turns_exceeded")
        yield create_status_message(
            "Analysis Failed", "failed", error_result["message"], 100
        )
        yield f"data: {json.dumps({'final_result': error_result}, default=str)}\n\n"

    except InputGuardrailTripwireTriggered as e:
        error_result = {
            "type": "error",
            "message": "Your document contains sensitive information that cannot be processed for security and privacy reasons.",
            "session_id": session_id,
        }
        metrics.log_guardrail_triggered(session_id, "input_guardrail", str(e))
        yield create_status_message(
            "Security Check Failed", "failed", error_result["message"]
        )
        yield f"data: {json.dumps({'final_result': error_result}, default=str)}\n\n"

    except OutputGuardrailTripwireTriggered as e:
        error_result = {
            "type": "error",
            "message": "Analysis output validation failed. Please try again with a different document.",
            "session_id": session_id,
        }
        metrics.log_guardrail_triggered(session_id, "output_guardrail", str(e))
        yield create_status_message(
            "Validation Check Failed", "failed", error_result["message"]
        )
        yield f"data: {json.dumps({'final_result': error_result}, default=str)}\n\n"

    except Exception as e:
        logger.analysis_error(session_id, f"Pipeline failed: {str(e)}", "CRITICAL_ERROR")
        metrics.log_analysis_error(session_id, str(e), "pipeline")
        error_result = {
            "type": "error",
            "message": "An error occurred during analysis. Please try again.",
            "session_id": session_id,
        }
        yield create_status_message("System Error", "failed", error_result["message"])
        yield f"data: {json.dumps({'final_result': error_result}, default=str)}\n\n"

    yield "data: [DONE]\n\n"
