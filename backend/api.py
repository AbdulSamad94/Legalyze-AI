"""API routes for document analysis."""

from fastapi import APIRouter, Depends, UploadFile, File, HTTPException, Request
from fastapi.responses import StreamingResponse
import json
from typing import AsyncGenerator

from auth import require_internal_secret
from config import settings
from infrastructure import rate_limiter
from services.analysis_pipeline import run_demo_pipeline, run_enhanced_pipeline_streamed
from utils import logger, file_processor

router = APIRouter(dependencies=[Depends(require_internal_secret)])


def _get_client_ip(request: Request) -> str:
    """
    Resolve the real client IP.

    Requests arrive via the Next.js proxy (src/app/api/demo/route.ts), which
    forwards the original visitor IP in X-Forwarded-For - without this, every
    demo request would appear to come from the proxy's own IP.

    Trusting this header is only safe because the router requires the shared
    secret: this runs solely for callers proven to be the proxy, so nobody else
    can pick their own rate limit key by faking the header.
    """
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


async def _extract_text_or_400(content: bytes, filename: str) -> str:
    """
    Extract real text from an uploaded file, failing fast with a 400 if the
    file type isn't supported, extraction fails, or the result doesn't look
    like actual text (binary/zip/PDF signature, null bytes, etc).

    This must be the ONLY path from raw upload bytes to agent input — never
    decode raw bytes as a fallback here.
    """
    try:
        text, _ = await file_processor.process_file(content, filename)
    except ValueError as e:
        logger.logger.warning(f"[EXTRACT] Rejected '{filename}': {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))

    return text


@router.post("/demo/")
async def demo_analysis(request: Request, file: UploadFile = File(...)):
    """
    Demo analysis endpoint - quick analysis without deep processing.
    Streams results as Server-Sent Events (SSE).
    """
    try:
        client_ip = _get_client_ip(request)
        allowed, retry_after = await rate_limiter.check(
            f"demo:{client_ip}",
            settings.rate_limit.demo_max_requests,
            settings.rate_limit.demo_window_seconds,
        )
        if not allowed:
            logger.logger.warning(f"[DEMO] Rate limit exceeded for {client_ip}")
            raise HTTPException(
                status_code=429,
                detail="Too many demo requests. Please try again later.",
                headers={"Retry-After": str(retry_after)},
            )

        if not file.filename:
            raise HTTPException(status_code=400, detail="No file provided")

        # Read and extract file content (fails fast on unsupported/corrupt/binary content)
        content = await file.read()
        text = await _extract_text_or_400(content, file.filename)

        logger.logger.info(f"[DEMO] Processing file: {file.filename}")

        async def event_generator() -> AsyncGenerator[str, None]:
            """Generate SSE events from analysis pipeline"""
            try:
                async for event in run_demo_pipeline(text, file.filename, "demo-session"):
                    yield event
            except Exception as e:
                logger.logger.error(f"[DEMO] Error in pipeline: {str(e)}")
                yield f"data: {json.dumps({'error': str(e)})}\n\n"

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.logger.error(f"[DEMO] Error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error processing file: {str(e)}")


@router.post("/analyze/")
async def analyze_document(file: UploadFile = File(...)):
    """
    Main analysis endpoint - full document analysis.
    Streams results as Server-Sent Events (SSE).
    """
    try:
        if not file.filename:
            raise HTTPException(status_code=400, detail="No file provided")

        # Read and extract file content (fails fast on unsupported/corrupt/binary content)
        content = await file.read()
        text = await _extract_text_or_400(content, file.filename)

        logger.logger.info(f"[ANALYZE] Processing file: {file.filename}")

        async def event_generator() -> AsyncGenerator[str, None]:
            """Generate SSE events from analysis pipeline"""
            try:
                async for event in run_enhanced_pipeline_streamed(text, file.filename, "main"):
                    yield event
            except Exception as e:
                logger.logger.error(f"[ANALYZE] Error in pipeline: {str(e)}")
                yield f"data: {json.dumps({'error': str(e)})}\n\n"

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.logger.error(f"[ANALYZE] Error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error processing file: {str(e)}")
