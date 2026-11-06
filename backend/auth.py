"""Authentication of requests coming from the Next.js server."""

import hmac

from fastapi import Header, HTTPException

from config import settings
from utils import logger


async def require_internal_secret(x_internal_secret: str | None = Header(default=None)) -> None:
    """
    Reject any request that doesn't carry the shared BACKEND_API_SECRET.

    Fails closed: a server with no secret configured refuses every request
    instead of treating the API as open.
    """
    if not settings.backend_auth.is_configured:
        logger.logger.error("[AUTH] BACKEND_API_SECRET not configured - refusing request")
        raise HTTPException(status_code=503, detail="Service not configured")

    # Compared as bytes: compare_digest raises TypeError on non-ASCII str,
    # and header values are attacker-controlled.
    supplied = (x_internal_secret or "").encode()
    if not hmac.compare_digest(supplied, settings.backend_auth.secret.encode()):
        raise HTTPException(status_code=401, detail="Unauthorized")
