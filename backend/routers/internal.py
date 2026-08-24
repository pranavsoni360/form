"""Internal HMAC-signed ingest endpoints for off-process error sources.

Why this exists:
    Backend errors flow into /ops/errors via the FastAPI global exception
    handler + event_bus. But errors from OUTSIDE this process —
    LiveKit voice agent on the GPU box, LiveKit server, SIP trunk, docker
    container OOM events, Postgres slow-query log — have nowhere to land.

    This module exposes a single HMAC-signed POST endpoint that any external
    service can hit. Events get published to the same event_bus "errors"
    topic that /ops/errors reads, so one dashboard shows everything.

Security:
    HMAC-SHA256 over the raw request body with a shared secret in
    LOS_INTERNAL_HMAC_SECRET. Senders pass the hex digest in
    `X-LOS-Signature`. Without the secret, callers get 401. Without
    the env var on the server, the endpoint returns 503 (disabled).

    The secret is NOT a JWT — it's a long-lived shared key. Rotate by
    setting LOS_INTERNAL_HMAC_SECRET to a new value + restarting + updating
    every caller. Keep it OUT of git.

Schema (POST body):
    {
        "source":         "agent" | "livekit" | "sip" | "docker" | "postgres",
        "level":          "error" | "warning"   (optional, default "error"),
        "exc_type":       str,                  (required, e.g. "TimeoutError")
        "message":        str,                  (required, human-readable)
        "correlation_id": str | None,           (optional; we generate uuid if absent)
        "route":          str | None,           (optional — for HTTP-shaped sources)
        "method":         str | None,           (optional)
        "trace":          str | None,           (optional stack trace, truncated to 4KB)
        "metadata":       dict | None,          (optional extra context, truncated)
    }
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import time
import uuid
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/internal", tags=["internal"])

VALID_SOURCES = frozenset({
    "agent",     # LiveKit Python voice agent
    "livekit",   # LiveKit Go server
    "sip",       # SIP trunk (Viva PSTN)
    "docker",    # Docker container events (OOM, restart)
    "postgres",  # Postgres log tailer
    "backend",   # Reserved; the FastAPI global handler uses this directly
    "frontend",  # Browser-reported errors (if we ever wire navigator.sendBeacon)
})

VALID_LEVELS = frozenset({"error", "warning"})

# Truncation caps — protect /ops/errors from giant payloads
MAX_MESSAGE_LEN = 500
MAX_TRACE_LEN = 4_000
MAX_METADATA_BYTES = 2_000


@router.post("/errors")
async def ingest_external_error(
    request: Request,
    x_los_signature: str = Header(default="", alias="X-LOS-Signature"),
):
    """Accept an error event from an external service and fan it out to
    the SSE "errors" topic. See module docstring for schema + security.
    """
    secret = os.getenv("LOS_INTERNAL_HMAC_SECRET", "").strip()
    if not secret:
        # Misconfigured server — refuse to silently accept unsigned events.
        raise HTTPException(503, "internal error ingest disabled (LOS_INTERNAL_HMAC_SECRET unset)")

    raw_body = await request.body()
    if not raw_body:
        raise HTTPException(400, "empty body")

    # Constant-time HMAC verify.
    expected = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, x_los_signature.lower()):
        # Don't tell the caller WHICH header / value was wrong — generic 401.
        raise HTTPException(401, "invalid signature")

    # Parse JSON
    try:
        body = json.loads(raw_body)
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"invalid JSON: {e.msg}")
    if not isinstance(body, dict):
        raise HTTPException(400, "body must be a JSON object")

    source = str(body.get("source", "")).strip().lower()
    if source not in VALID_SOURCES:
        raise HTTPException(
            400,
            f"invalid source {source!r}; must be one of {sorted(VALID_SOURCES)}",
        )

    level = str(body.get("level", "error")).strip().lower()
    if level not in VALID_LEVELS:
        level = "error"  # be lenient on level — default rather than 400

    exc_type = str(body.get("exc_type", "")).strip() or "ExternalError"
    message = str(body.get("message", "")).strip()[:MAX_MESSAGE_LEN]
    correlation_id = str(body.get("correlation_id", "")).strip() or uuid.uuid4().hex
    route = body.get("route")
    method = body.get("method")
    trace = body.get("trace")
    metadata = body.get("metadata")

    if trace is not None:
        trace = str(trace)[:MAX_TRACE_LEN]
    if metadata is not None:
        try:
            md_bytes = json.dumps(metadata, default=str).encode("utf-8")
            if len(md_bytes) > MAX_METADATA_BYTES:
                # Keep first ~2 KB as a string sample so caller knows it was truncated.
                metadata = {
                    "_truncated": True,
                    "sample": md_bytes[:MAX_METADATA_BYTES].decode("utf-8", errors="replace"),
                }
        except (TypeError, ValueError):
            metadata = {"_invalid": True}

    payload: dict[str, Any] = {
        "type": "error",
        "source": source,
        "level": level,
        "correlation_id": correlation_id,
        "exc_type": exc_type,
        "message": message,
    }
    # Only include optional fields when present — keeps SSE wire smaller.
    if route is not None:
        payload["route"] = str(route)[:200]
    if method is not None:
        payload["method"] = str(method)[:10]
    if trace is not None:
        payload["trace"] = trace
    if metadata is not None:
        payload["metadata"] = metadata

    # Publish — never raise from here even if event_bus misbehaves.
    try:
        from lib.event_bus import event_bus
        event_bus.publish("errors", payload)
    except Exception:
        logger.exception("internal/errors: event_bus.publish failed (event dropped)")
        # Still 200 — we got a valid signed event; failure to fan-out is OUR bug.

    # Structured log so the event is captured even if event_bus fan-out fails.
    # NOTE: do NOT pass `message` in extra={} — Python's logging module reserves
    # that key on LogRecord and raises KeyError on overwrite. Use `error_msg`.
    logger.warning(
        "external_error_ingested",
        extra={
            "source": source,
            "level": level,
            "exc_type": exc_type,
            "correlation_id": correlation_id,
            "error_msg": message[:200],
        },
    )

    return {"ok": True, "correlation_id": correlation_id, "ts": time.time()}


# ════════════════════════════════════════════════════════════════════════════
# FRONTEND error reporter — JWT-gated companion endpoint
# ════════════════════════════════════════════════════════════════════════════
# Browser JS errors (window.error, unhandledrejection, React error boundaries)
# need a way to land in /ops/errors WITHOUT requiring the HMAC shared secret
# (we'd have to ship the secret to the browser → defeats its purpose).
#
# This endpoint accepts a logged-in admin/bank/vendor JWT instead. The caller
# can't spoof source — we force it to "frontend" server-side. Cheap rate limit
# is enforced by truncating long messages + capping metadata.

_browser_security = HTTPBearer(auto_error=False)

# Anonymous browser errors are accepted on purpose (a crash on the login page
# would otherwise be lost), but that also means any internet client can inject
# arbitrary exc_type / message / trace rows straight into the operator error
# console - with nothing to stop it drowning out a real incident. Capped per
# source IP by the shared limiter (bucket "frontend_error", tunable with
# RATELIMIT_FRONTEND_ERROR). Kept as a named wrapper so the call site reads as
# intent rather than plumbing.


def _anon_rate_ok(ip: str) -> bool:
    from services import ratelimit as _ratelimit

    return _ratelimit.allow("frontend_error", ip)



@router.post("/frontend-error")
async def report_frontend_error(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_browser_security),
):
    """Browser-side error reporter. Any logged-in user can post; source is
    forced to 'frontend' so callers can't pretend to be the backend or agent.

    Schema:
        { exc_type, message, route?, trace?, metadata?, level? }
    correlation_id is generated server-side (browsers don't carry the same
    request-correlation context that backend exceptions do).
    """
    # JWT check — any valid token from any role is fine; we just need to know
    # this isn't an anonymous attacker spamming.
    if credentials is None:
        # Unauthenticated browser errors (e.g. error before login) — accept
        # silently with a relaxed cap so login-page crashes don't go missing,
        # but rate-limit per IP (see _anon_rate_ok).
        from services.audit import get_client_ip
        peer = get_client_ip(request) or "unknown"
        if not _anon_rate_ok(peer):
            raise HTTPException(429, "too many anonymous error reports")
        user_label = "anonymous"
    else:
        try:
            import jwt as _jwt
            import main as _main
            payload = _jwt.decode(credentials.credentials, _main.JWT_SECRET, algorithms=["HS256"])
            user_label = f"{payload.get('user_type', '?')}/{payload.get('user_id', '?')[:8]}"
        except Exception:
            raise HTTPException(401, "invalid token")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "invalid JSON")
    if not isinstance(body, dict):
        raise HTTPException(400, "body must be a JSON object")

    exc_type = str(body.get("exc_type", "")).strip() or "BrowserError"
    message = str(body.get("message", "")).strip()[:MAX_MESSAGE_LEN]
    level = str(body.get("level", "error")).strip().lower()
    if level not in VALID_LEVELS:
        level = "error"
    route = body.get("route")
    trace = body.get("trace")
    metadata = body.get("metadata")

    if trace is not None:
        trace = str(trace)[:MAX_TRACE_LEN]
    if metadata is not None:
        try:
            md_bytes = json.dumps(metadata, default=str).encode("utf-8")
            if len(md_bytes) > MAX_METADATA_BYTES:
                metadata = {"_truncated": True, "sample": md_bytes[:MAX_METADATA_BYTES].decode("utf-8", errors="replace")}
        except (TypeError, ValueError):
            metadata = {"_invalid": True}

    correlation_id = uuid.uuid4().hex
    payload_out: dict[str, Any] = {
        "type": "error",
        "source": "frontend",  # forced — caller cannot override
        "level": level,
        "correlation_id": correlation_id,
        "exc_type": exc_type,
        "message": message,
        "reported_by": user_label,
    }
    if route is not None:
        payload_out["route"] = str(route)[:200]
    if trace is not None:
        payload_out["trace"] = trace
    if metadata is not None:
        payload_out["metadata"] = metadata

    try:
        from lib.event_bus import event_bus
        event_bus.publish("errors", payload_out)
    except Exception:
        logger.exception("frontend-error: event_bus.publish failed (event dropped)")

    logger.warning(
        "frontend_error_ingested",
        extra={
            "exc_type": exc_type,
            "level": level,
            "route": route,
            "reported_by": user_label,
            "error_msg": message[:200],
        },
    )

    return {"ok": True, "correlation_id": correlation_id}
