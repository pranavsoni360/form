"""Per-key sliding-window rate limits.

Why in-process and not Redis: the backend runs as a single uvicorn process with
no `--workers` (see `run.sh` and `scripts/deploy.sh`), and the batch/analytics
locks in `agent/state.py` already rely on that. When those move to the DB and we
scale out, these counters move with them — the call sites do not change.

What this exists to stop, none of which had any limit before:

  * The Aadhaar and PAN endpoints are **paid** third-party calls. An
    unauthenticated caller holding one OTP-verified form token could loop them
    and run up the vendor bill (cost amplification). These carry two limits: a
    loose per-IP one (Indian mobile carriers use CGNAT, so a tight per-IP cap
    would block real applicants sharing an address) and a tight per-token one,
    which is the dimension an abuse loop cannot spread across.
  * The export endpoints stream every call record for a bank in one request.
    Nothing throttled repeated pulls.
  * Login had a per-**username** lockout but no IP dimension, so credential
    stuffing across many usernames from one host was unbounded — and an
    attacker who knows usernames could lock out every user on purpose. This adds
    the IP dimension alongside, it does not replace the lockout.

Buckets are named so limits can be tuned per surface without touching code:
`RATELIMIT_<BUCKET>` = "<max>/<window_seconds>", e.g. RATELIMIT_AADHAAR=20/3600.
"""
from __future__ import annotations

import logging
import os
import time
from collections import deque
from typing import Deque

from fastapi import HTTPException

logger = logging.getLogger("ratelimit")

# bucket -> (max events, window seconds). Deliberately generous: these are abuse
# ceilings, not product limits. A real applicant never approaches them.
_DEFAULTS: dict[str, tuple[int, int]] = {
    # Paid KYC vendor calls. Two dimensions, because neither alone is right:
    #   *_ip    — deliberately loose. Indian mobile carriers use CGNAT, so a
    #             whole branch office (or a whole cell) can share one address;
    #             a tight per-IP cap would block real applicants. Even at this
    #             level it stops an abuse loop dead, which runs thousands/hour.
    #   aadhaar / pan — per form token or session, the precise control: one
    #             application has no legitimate reason to need more than this.
    "aadhaar_ip": (120, 3600),
    "pan_ip": (120, 3600),
    "aadhaar": (12, 3600),
    "pan": (12, 3600),
    # Bulk data pulls, per authenticated user.
    "export": (20, 3600),
    # Credential stuffing, per client IP — complements the per-username lockout.
    "login_ip": (30, 900),
    # Anonymous browser error reports, per client IP.
    "frontend_error": (10, 60),
}

# Cap the number of tracked keys per bucket. An abuse guard may forget who it saw
# under pressure; it must not become the memory leak.
_MAX_KEYS_PER_BUCKET = 5000

_hits: dict[str, dict[str, Deque[float]]] = {}


def _limit_for(bucket: str) -> tuple[int, int]:
    raw = os.getenv(f"RATELIMIT_{bucket.upper()}", "").strip()
    if raw:
        try:
            n, w = raw.split("/", 1)
            return max(1, int(n)), max(1, int(w))
        except (ValueError, TypeError):
            logger.warning("bad RATELIMIT_%s=%r, using the default", bucket.upper(), raw)
    return _DEFAULTS.get(bucket, (60, 60))


def allow(bucket: str, key: str) -> bool:
    """Record one event. False when `key` is over the limit for `bucket`."""
    max_events, window = _limit_for(bucket)
    now = time.time()
    keys = _hits.setdefault(bucket, {})
    if len(keys) > _MAX_KEYS_PER_BUCKET:
        keys.clear()
    q = keys.setdefault(key or "unknown", deque())
    while q and q[0] < now - window:
        q.popleft()
    if len(q) >= max_events:
        return False
    q.append(now)
    return True


def check(bucket: str, key: str) -> None:
    """allow(), but raise 429 with Retry-After instead of returning False."""
    if allow(bucket, key):
        return
    max_events, window = _limit_for(bucket)
    keys = _hits.get(bucket, {})
    q = keys.get(key or "unknown")
    retry = int(window - (time.time() - q[0])) + 1 if q else window
    logger.warning("rate limit hit: bucket=%s key=%s (%d/%ds)",
                   bucket, key, max_events, window)
    raise HTTPException(
        status_code=429,
        detail=f"Too many requests. Try again in {max(1, retry)} seconds.",
        headers={"Retry-After": str(max(1, retry))},
    )


def check_request(bucket: str, request) -> None:
    """check() keyed on the real client IP behind nginx."""
    from services.audit import get_client_ip
    check(bucket, get_client_ip(request) or "unknown")


def reset(bucket: str | None = None) -> None:
    """Clear counters. For tests and for an operator un-wedging a bucket."""
    if bucket is None:
        _hits.clear()
    else:
        _hits.pop(bucket, None)
