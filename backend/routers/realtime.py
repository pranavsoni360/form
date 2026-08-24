"""
Realtime SSE endpoints.

Two routes:
  POST /api/realtime/stream-token
      Caller passes their existing access JWT (admin or bank-user) via the
      usual Authorization: Bearer header. We mint a SHORT-LIVED (5 min)
      JWT scoped `aud=sse` with the list of topics this user is allowed
      to subscribe to. Returned as {"token": "...", "expires_in": 300}.

      Browsers can't set Authorization on EventSource, so the SSE token
      flows through the URL — short TTL + dedicated audience keeps blast
      radius small.

  GET /api/realtime/events?token=<sse-jwt>&topics=calls,phones,…
      Verifies the SSE JWT. Intersects requested topics with the JWT's
      allowed-topics claim. Subscribes to event_bus, streams JSON events
      as `data: {…}\n\n` SSE frames. Heartbeats every 15 s defeat proxy
      buffering. Auto-closes after 25 min so the client refetches a token
      and reconnects (keeping JWTs short-lived).

Bank-user scoping: events on the "calls" / "batches" topics carry a
`bank_id` field. Bank-user subscribers only see events matching their
own `bank_id`. Admin sees everything.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from lib.event_bus import VALID_TOPICS, event_bus

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/realtime", tags=["realtime"])
_bearer = HTTPBearer(auto_error=True)

JWT_SECRET = os.getenv("JWT_SECRET", "")  # main.py validates non-default
SSE_TOKEN_TTL_SECONDS = 300              # 5 min — matches plan
SSE_STREAM_MAX_SECONDS = 1500            # 25 min — under most LB idle limits
SSE_HEARTBEAT_SECONDS = 15               # defeat proxy buffering


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _topics_for(role: str, user_type: str) -> frozenset[str]:
    """Authorization matrix — who sees what."""
    if user_type == "admin":
        return frozenset(VALID_TOPICS)  # everything
    if user_type == "bank_user":
        # Bank ops folk see live calls + batch progress for their bank only
        # (per-event bank_id filter applied at stream time).
        return frozenset({"calls", "batches"})
    return frozenset()


# ── POST /api/realtime/stream-token ──────────────────────────────────────────
@router.post("/stream-token")
async def issue_stream_token(
    creds: HTTPAuthorizationCredentials = Depends(_bearer),
):
    """Mint a short-lived SSE-scoped JWT from the caller's regular access JWT.

    We don't reuse the access token directly because:
    1. Browser EventSource can only pass the token via querystring (which
       might end up in proxy logs) — short TTL contains the leak window.
    2. `aud=sse` lets us refuse this token on any other route, even if a
       leak happens.
    """
    try:
        access = jwt.decode(creds.credentials, JWT_SECRET, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "access token expired")
    except Exception:
        raise HTTPException(401, "invalid access token")
    # A refresh token would otherwise be exchangeable for an SSE stream token.
    if access.get("type") == "refresh":
        raise HTTPException(401, "refresh token cannot be exchanged for a stream token")

    user_id = access.get("user_id")
    user_type = access.get("user_type")
    role = access.get("role")
    bank_id = access.get("bank_id")
    if not user_id or not user_type:
        raise HTTPException(401, "malformed access token")

    allowed = _topics_for(role or "", user_type)
    if not allowed:
        raise HTTPException(403, f"user_type={user_type} not allowed to subscribe")

    payload = {
        "aud": "sse",
        "user_id": user_id,
        "user_type": user_type,
        "role": role,
        "bank_id": bank_id,
        "topics": sorted(allowed),
        "iat": int(_now().timestamp()),
        "exp": int((_now() + timedelta(seconds=SSE_TOKEN_TTL_SECONDS)).timestamp()),
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm="HS256")
    return {
        "token": token,
        "expires_in": SSE_TOKEN_TTL_SECONDS,
        "allowed_topics": sorted(allowed),
    }


# ── GET /api/realtime/events ─────────────────────────────────────────────────
@router.get("/events")
async def stream_events(
    request: Request,
    token: str = Query(..., min_length=20),
    topics: str = Query("calls", description="Comma-separated topic list"),
):
    """SSE endpoint. Returns text/event-stream until client disconnects or
    SSE_STREAM_MAX_SECONDS elapses (then the client reconnects with a
    fresh token)."""
    try:
        claims = jwt.decode(
            token, JWT_SECRET, algorithms=["HS256"], audience="sse",
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "sse token expired")
    except jwt.InvalidAudienceError:
        raise HTTPException(401, "wrong token audience")
    except Exception:
        raise HTTPException(401, "invalid sse token")

    allowed = frozenset(claims.get("topics", []))
    requested = frozenset(t.strip() for t in topics.split(",") if t.strip())
    effective = requested & allowed
    if not effective:
        raise HTTPException(403, f"none of requested topics {sorted(requested)} are allowed")

    is_admin = claims.get("user_type") == "admin"
    bank_id = claims.get("bank_id")
    user_id = claims.get("user_id")

    async def _gen():
        # Initial comment so proxies open the connection. SSE spec allows
        # any leading `:` lines.
        yield ":ok\n\n".encode()

        # Hand the connection token + scope back so the client can confirm
        # what it's actually subscribed to.
        intro = {
            "type": "_connected",
            "topics": sorted(effective),
            "stream_max_seconds": SSE_STREAM_MAX_SECONDS,
        }
        yield f"data: {json.dumps(intro)}\n\n".encode()

        sub_gen = event_bus.subscribe(effective)
        stream_started = time.monotonic()
        last_yield_at = time.monotonic()

        try:
            while True:
                # Time-bound stream so JWTs stay short-lived.
                elapsed = time.monotonic() - stream_started
                if elapsed >= SSE_STREAM_MAX_SECONDS:
                    yield b": stream_max reached, please reconnect\n\n"
                    return

                # Heartbeat if we haven't yielded recently.
                since_yield = time.monotonic() - last_yield_at
                heartbeat_in = max(1.0, SSE_HEARTBEAT_SECONDS - since_yield)

                try:
                    event = await asyncio.wait_for(anext(sub_gen), timeout=heartbeat_in)
                except asyncio.TimeoutError:
                    # No event for ≥15s — send a comment heartbeat. Comments
                    # don't fire EventSource `onmessage`, so client-side this
                    # is invisible apart from keeping the connection warm.
                    yield f": heartbeat {int(time.time())}\n\n".encode()
                    last_yield_at = time.monotonic()
                    continue
                except StopAsyncIteration:
                    # Upstream generator finished (event_bus closed our sub).
                    # PEP 479: raising StopAsyncIteration from inside an async
                    # generator becomes a RuntimeError("async generator raised
                    # StopAsyncIteration") and trips the FastAPI global handler
                    # — polluting /ops/errors with phantom errors on every
                    # planned SSE close (token refresh, page navigate). Treat
                    # it as a clean end-of-stream instead.
                    yield b": upstream closed, please reconnect\n\n"
                    return

                # bank-user row filter: skip events not for this bank.
                if not is_admin and event.get("bank_id") and event["bank_id"] != bank_id:
                    continue

                # Disconnected? FastAPI sets request.is_disconnected().
                if await request.is_disconnected():
                    return

                yield f"data: {json.dumps(event, default=str)}\n\n".encode()
                last_yield_at = time.monotonic()
        finally:
            # Closing the async-gen unsubscribes via its finally block.
            try:
                await sub_gen.aclose()
            except Exception:
                pass

    return StreamingResponse(
        _gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # nginx: disable response buffering
        },
    )


