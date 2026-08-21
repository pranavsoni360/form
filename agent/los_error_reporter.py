# -*- coding: utf-8 -*-
"""
LOS Error Reporter — voice agent → backend /api/internal/errors webhook.

What this does:
    Every logger.error() call AND every uncaught exception inside the agent
    process gets posted (HMAC-signed) to the LOS backend's webhook so it
    shows up in /ops/errors alongside backend / browser / livekit / sip /
    docker errors. Production-grade observability without changing every
    `logger.error(...)` call site.

Why this exists:
    The agent (this Python process) runs on the GPU box inside Docker. The
    LOS backend runs separately. Until now agent crashes only flowed to
    stdout/journald — invisible to operators on the /ops/errors dashboard.

Activation:
    from los_error_reporter import install
    install()   # at module top of los_agent.py / agent_core.py / wherever entry is

Required env (in agent/.env.local):
    LOS_BACKEND_URL             https://virtualvaani.vgipl.com:8200  (or http://localhost:8200 for dev)
    LOS_INTERNAL_HMAC_SECRET    same value as backend/.env

Tuneable env:
    LOS_REPORT_TLS_VERIFY       1 (default) | 0 — set 0 when posting to the
                                backend over https on 127.0.0.1, whose cert is
                                issued for the public hostname and so fails
                                hostname verification on the loopback address.
    LOS_REPORT_LEVEL            warning | error    (default: error — only ERROR+ go to webhook)
    LOS_REPORT_DEDUP_WINDOW_S   default 60 — suppress same (logger_name, message) within N seconds
    LOS_REPORT_MAX_QPS          default 5 — burst cap; excess silently dropped (avoid backend self-DOS)

Design notes:
    - Fire-and-forget: every POST runs as a background coroutine. Logger
      itself stays sync and never blocks the agent's call loop.
    - Dedup window: noisy STT reconnect loops would otherwise spam the
      endpoint. Same (logger, message) within 60s = one row, not many.
    - Excepthook for non-async crashes (the kind that take the process
      down) + a global asyncio exception handler for uncaught task crashes.
    - Failure to POST is logged once at debug level then absorbed — never
      let observability bring down the agent.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import sys
import threading
import time
import traceback
from collections import deque
from typing import Optional

import aiohttp

_logger = logging.getLogger("los-error-reporter")

# ── config (read once at install()) ─────────────────────────────────────────
_CONFIG = {
    "backend_url": "",
    "secret": "",
    "min_level": logging.ERROR,
    "dedup_window_s": 60,
    "max_qps": 5,
    "endpoint": "/api/internal/errors",
    "tls_verify": True,
}

# Dedup memory — short ring of recently sent (key, ts) so we suppress dupes.
_DEDUP: deque[tuple[str, float]] = deque(maxlen=500)
_RATE_BUCKET: deque[float] = deque(maxlen=50)   # timestamps of last sends for QPS cap
_LOOP: Optional[asyncio.AbstractEventLoop] = None
_INSTALLED = False


def _sign(body: bytes) -> str:
    return hmac.new(_CONFIG["secret"].encode("utf-8"), body, hashlib.sha256).hexdigest()


def _should_send(key: str) -> bool:
    """Dedup + rate-limit gate. Returns False if we should drop this event."""
    now = time.time()
    cutoff = now - _CONFIG["dedup_window_s"]
    # Sweep old dedup entries opportunistically.
    while _DEDUP and _DEDUP[0][1] < cutoff:
        _DEDUP.popleft()
    for k, t in _DEDUP:
        if k == key:
            return False  # duplicate within window
    # Rate limit — last second
    while _RATE_BUCKET and _RATE_BUCKET[0] < now - 1.0:
        _RATE_BUCKET.popleft()
    if len(_RATE_BUCKET) >= _CONFIG["max_qps"]:
        return False
    _DEDUP.append((key, now))
    _RATE_BUCKET.append(now)
    return True


async def _post(payload: dict) -> None:
    """Sign + POST. Never raises."""
    if not _CONFIG["backend_url"] or not _CONFIG["secret"]:
        return
    url = _CONFIG["backend_url"].rstrip("/") + _CONFIG["endpoint"]
    body = json.dumps(payload, default=str).encode("utf-8")
    sig = _sign(body)
    try:
        timeout = aiohttp.ClientTimeout(total=5)
        # The backend serves TLS on loopback with a cert issued for its public
        # hostname, so https://127.0.0.1:<port> fails hostname verification.
        # LOS_REPORT_TLS_VERIFY=0 turns verification off for that hop — safe
        # because the request never leaves the box and is HMAC-signed anyway.
        connector = None
        if not _CONFIG["tls_verify"] and url.startswith("https://"):
            connector = aiohttp.TCPConnector(ssl=False)
        async with aiohttp.ClientSession(timeout=timeout, connector=connector) as sess:
            async with sess.post(
                url,
                data=body,
                headers={"Content-Type": "application/json", "X-LOS-Signature": sig},
            ) as resp:
                if resp.status >= 400:
                    _logger.debug("error report rejected: HTTP %s", resp.status)
    except Exception as e:  # noqa: BLE001 — observability NEVER crashes the agent
        _logger.debug("error report failed: %s", e)


def _schedule(payload: dict) -> None:
    """Hand off to the event loop. Safe from any thread."""
    global _LOOP
    loop = _LOOP
    # install() normally runs at module import time, before the agent's event
    # loop exists, so there is nothing to capture then. Capture the real
    # running loop here, on the first report. Also re-capture if the loop we
    # were given has since closed or never started — queueing onto a loop that
    # does not run means the report is silently dropped.
    if loop is None or loop.is_closed() or not loop.is_running():
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return  # not on a loop thread and nothing usable captured — drop
        _LOOP = loop
    try:
        # If called from the loop's own thread (most common), use create_task.
        # Otherwise (logging from a non-async thread) use run_coroutine_threadsafe.
        if threading.current_thread() is threading.main_thread():
            try:
                if asyncio.get_running_loop() is loop:
                    loop.create_task(_post(payload))
                    return
            except RuntimeError:
                pass
        asyncio.run_coroutine_threadsafe(_post(payload), loop)
    except Exception:
        pass  # never propagate


# ── logging handler — every logger.error() gets POSTed ──────────────────────
class _LOSErrorHandler(logging.Handler):
    def __init__(self):
        super().__init__(level=_CONFIG["min_level"])

    def emit(self, record: logging.LogRecord) -> None:
        try:
            if record.levelno < _CONFIG["min_level"]:
                return
            # Skip our own logs to avoid feedback loops
            if record.name == "los-error-reporter":
                return

            message = record.getMessage()[:1000]
            key = f"{record.name}|{message[:120]}"
            if not _should_send(key):
                return

            exc_type = "AgentLog"
            trace = None
            if record.exc_info:
                exc_type = record.exc_info[0].__name__ if record.exc_info[0] else "Exception"
                trace = "".join(traceback.format_exception(*record.exc_info))[:4000]

            payload = {
                "source": "agent",
                "level": "warning" if record.levelno < logging.ERROR else "error",
                "exc_type": exc_type,
                "message": message,
                "metadata": {
                    "logger": record.name,
                    "module": record.module,
                    "func": record.funcName,
                    "line": record.lineno,
                },
            }
            if trace is not None:
                payload["trace"] = trace
            _schedule(payload)
        except Exception:
            pass  # observability NEVER crashes the producer


def _excepthook(exc_type, exc_value, exc_tb):
    """Catches uncaught sync exceptions that would otherwise kill the process."""
    try:
        trace = "".join(traceback.format_exception(exc_type, exc_value, exc_tb))[:4000]
        message = f"{exc_type.__name__}: {exc_value}"[:1000]
        if _should_send(f"excepthook|{message[:120]}"):
            _schedule({
                "source": "agent",
                "level": "error",
                "exc_type": exc_type.__name__,
                "message": message,
                "trace": trace,
                "metadata": {"origin": "sys.excepthook"},
            })
    finally:
        # Always call the original hook so behavior is unchanged
        sys.__excepthook__(exc_type, exc_value, exc_tb)


def _async_excepthook(loop, context):
    """Catches uncaught asyncio task exceptions (the most common failure mode
    for LiveKit agents — a background task throws and nobody awaited it)."""
    try:
        exc = context.get("exception")
        message = (context.get("message") or "uncaught asyncio exception")[:1000]
        if exc:
            trace = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))[:4000]
            exc_name = type(exc).__name__
        else:
            trace = None
            exc_name = "AsyncioError"
        if _should_send(f"asyncio|{message[:120]}"):
            _schedule({
                "source": "agent",
                "level": "error",
                "exc_type": exc_name,
                "message": message,
                "trace": trace,
                "metadata": {"origin": "asyncio.exception_handler"},
            })
    finally:
        # Pass through to default handler so logs still happen
        loop.default_exception_handler(context)


def install(
    backend_url: Optional[str] = None,
    secret: Optional[str] = None,
    loop: Optional[asyncio.AbstractEventLoop] = None,
) -> bool:
    """Mount the reporter. Idempotent. Returns True if armed, False if disabled
    (missing env). Call this once at agent boot."""
    global _INSTALLED, _LOOP
    if _INSTALLED:
        return True

    _CONFIG["backend_url"] = (backend_url or os.getenv("LOS_BACKEND_URL", "")).strip()
    _CONFIG["secret"] = (secret or os.getenv("LOS_INTERNAL_HMAC_SECRET", "")).strip()
    lvl_env = (os.getenv("LOS_REPORT_LEVEL", "error") or "error").lower()
    _CONFIG["min_level"] = logging.WARNING if lvl_env == "warning" else logging.ERROR
    try:
        _CONFIG["dedup_window_s"] = int(os.getenv("LOS_REPORT_DEDUP_WINDOW_S", "60"))
    except ValueError:
        _CONFIG["dedup_window_s"] = 60
    try:
        _CONFIG["max_qps"] = int(os.getenv("LOS_REPORT_MAX_QPS", "5"))
    except ValueError:
        _CONFIG["max_qps"] = 5
    _CONFIG["tls_verify"] = (
        os.getenv("LOS_REPORT_TLS_VERIFY", "1").strip().lower()
        not in ("0", "false", "no", "off")
    )

    if not _CONFIG["backend_url"] or not _CONFIG["secret"]:
        _logger.warning(
            "LOS error reporter NOT armed — set LOS_BACKEND_URL + "
            "LOS_INTERNAL_HMAC_SECRET in .env.local to enable",
        )
        return False

    # Resolve the loop. If we're called before the loop starts (the
    # LiveKit pattern is to install pre-WorkerOptions), defer it: try to
    # capture the running loop on first emit instead.
    if loop is not None:
        _LOOP = loop
    else:
        try:
            # get_running_loop(), NOT get_event_loop(): install() is called at
            # module import time, before the agent's loop exists. On 3.12
            # get_event_loop() hands back a brand-new loop that never runs, and
            # every report queued onto it is lost without a trace. None is the
            # honest answer — _schedule() captures the real loop on first use.
            _LOOP = asyncio.get_running_loop()
        except RuntimeError:
            _LOOP = None  # picked up lazily by _schedule()

    # Attach to the ROOT logger so every getLogger(...) inside the agent
    # benefits without per-module wiring.
    handler = _LOSErrorHandler()
    handler.setLevel(_CONFIG["min_level"])
    logging.getLogger().addHandler(handler)

    # Catch uncaught sync exceptions (process killers)
    sys.excepthook = _excepthook

    # If the loop already exists, install the asyncio handler too. If not,
    # the user can call attach_async_handler() after creating the loop.
    if _LOOP is not None:
        try:
            _LOOP.set_exception_handler(_async_excepthook)
        except Exception:
            pass

    _INSTALLED = True
    _logger.info(
        "LOS error reporter armed → %s%s (min=%s, dedup=%ds, max_qps=%d, tls_verify=%s)",
        _CONFIG["backend_url"], _CONFIG["endpoint"],
        logging.getLevelName(_CONFIG["min_level"]),
        _CONFIG["dedup_window_s"], _CONFIG["max_qps"], _CONFIG["tls_verify"],
    )
    return True


def attach_async_handler(loop: asyncio.AbstractEventLoop) -> None:
    """If you call install() before the event loop exists, call this once
    the loop is created to wire the asyncio-level exception handler too."""
    global _LOOP
    _LOOP = loop
    try:
        loop.set_exception_handler(_async_excepthook)
    except Exception:
        pass


def report(
    exc_type: str,
    message: str,
    level: str = "error",
    trace: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> None:
    """Manual report — for try/except blocks that catch + handle locally
    but want operators to still see what happened."""
    if not _INSTALLED:
        return
    payload = {
        "source": "agent",
        "level": "warning" if level == "warning" else "error",
        "exc_type": exc_type[:200],
        "message": message[:1000],
        "metadata": metadata or {},
    }
    if trace is not None:
        payload["trace"] = str(trace)[:4000]
    if _should_send(f"manual|{message[:120]}"):
        _schedule(payload)
