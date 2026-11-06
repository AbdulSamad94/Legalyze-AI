"""FastAPI application with clean architecture."""

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from starlette.middleware.cors import CORSMiddleware
import asyncio

from config import settings
from infrastructure import model_manager, cache_manager, rate_limiter
from utils import logger

# Initialize app
app = FastAPI(
    title=settings.api_title,
    description=settings.api_description,
    version=settings.api_version,
)

# CORS middleware configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "https://legalyze-ai.vercel.app",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================================
# STARTUP / SHUTDOWN EVENTS
# ============================================================================


@app.on_event("startup")
async def startup_event():
    """Initialize services on startup"""
    logger.logger.info("[APP] Starting up...")

    # Initialize models
    success, errors = model_manager.initialize()
    if errors:
        for error in errors:
            logger.logger.warning(f"[APP] {error}")

    if not success:
        logger.logger.error("[APP] Failed to initialize models")
        raise RuntimeError("Could not initialize AI models")

    # Initialize cache
    cache_connected = await cache_manager.connect()
    if cache_connected:
        logger.logger.info("[APP] Cache initialized")
    else:
        logger.logger.warning("[APP] Cache unavailable - running in degraded mode")

    # Initialize rate limiter
    rate_limit_connected = await rate_limiter.connect()
    if rate_limit_connected:
        logger.logger.info("[APP] Rate limiter initialized")
    else:
        logger.logger.warning("[APP] Rate limiter unavailable - public endpoints unthrottled")

    logger.logger.info("[APP] Startup complete")


@app.on_event("shutdown")
async def shutdown_event():
    """Clean up resources on shutdown"""
    logger.logger.info("[APP] Shutting down...")
    await cache_manager.close()
    await rate_limiter.close()
    logger.logger.info("[APP] Shutdown complete")


# ============================================================================
# HEALTH ENDPOINTS
# ============================================================================


@app.get("/")
async def root():
    """Root endpoint with API information"""
    from utils import SUPPORTED_EXTENSIONS
    return {
        "message": "LegalyzeAI API is running!",
        "status": "healthy",
        "version": "1.0.0",
        "features": [
            "Legal document analysis",
            "Risk assessment",
            "Clause checking",
            "Document summarization",
        ],
        "supported_formats": SUPPORTED_EXTENSIONS,
    }


@app.get("/health")
async def health_check():
    """Health check endpoint with service status"""
    from datetime import datetime

    cache_status = "connected" if cache_manager.client else "disconnected"
    rate_limit_status = "connected" if rate_limiter.client else "disconnected"

    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "service": "LegalyzeAI Backend",
        "features": {
            "demo_analysis": "available",
            "main_analysis": "available",
        },
        "infrastructure": {
            "cache": cache_status,
            "rate_limiter": rate_limit_status,
            "models": "initialized" if model_manager.openai_model else "not_initialized",
        },
    }


# ============================================================================
# API ROUTES
# ============================================================================

from api import router as api_router

# Include API routes
app.include_router(api_router)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
    )
