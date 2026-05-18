"""
Discord webhook alerts with rate-limited token bucket.

Why rate limiting:
- During an incident, the same root cause can trigger hundreds of similar
  errors. Without rate limiting, Discord becomes unreadable noise.
- Token bucket per `dedupe_key`: 1 alert / 5 min / key. After 30 min we emit
  a "still firing" summary so you know the issue persists.

Usage:
    from lib.notifier import notify
    await notify(
        severity="critical",
        title="Job worker died",
        body="JobWorker w0 crashed: ConnectionError to Postgres",
        dedupe_key="worker_crash:w0",
    )

If DISCORD_WEBHOOK_URL is not set, this becomes a no-op (logs a warning once
on startup).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field

import httpx


logger = logging.getLogger(__name__)

DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "").strip()

# Token-bucket window: minimum gap between alerts with the SAME dedupe_key.
ALERT_COOLDOWN_SECONDS = 300       # 5 minutes
# After this many seconds of continuous firing, send a "still firing" summary.
STILL_FIRING_INTERVAL_SECONDS = 1800  # 30 minutes

# Discord embed body cap (their hard limit is 2000 for content / 4096 for
# embed description; we stay conservative).
MAX_BODY_LEN = 1800

# Severity → Discord embed color (decimal).
_COLOR = {
    "info":     0x3498DB,  # blue
    "warning":  0xF1C40F,  # yellow
    "critical": 0xE74C3C,  # red
}


@dataclass
class _AlertState:
    last_sent_at: float = 0.0
    last_firing_summary_at: float = 0.0
    suppressed_count: int = 0


_state: dict[str, _AlertState] = {}
_state_lock = asyncio.Lock()
_no_webhook_warned = False


def _truncate(s: str, n: int = MAX_BODY_LEN) -> str:
    if len(s) <= n:
        return s
    return s[: n - 20] + "\n…(truncated)"


async def _post_to_discord(payload: dict) -> None:
    """POST to Discord with a short timeout. Errors are logged but never
    raised — alerting must never block or crash the caller."""
    if not DISCORD_WEBHOOK_URL:
        return
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(DISCORD_WEBHOOK_URL, json=payload)
            if resp.status_code >= 400:
                logger.warning(
                    "Discord webhook returned %d: %s",
                    resp.status_code, resp.text[:200],
                )
    except Exception as e:
        logger.warning("Discord webhook POST failed: %s", e)


async def notify(
    severity: str,
    title: str,
    body: str,
    dedupe_key: str,
    *,
    fields: dict[str, str] | None = None,
) -> None:
    """Send an alert subject to rate-limiting per dedupe_key.

    Args:
        severity: "info" | "warning" | "critical"
        title: short headline (Discord embed title)
        body: details, stack traces, etc. (truncated to ~1800 chars)
        dedupe_key: stable string for rate limiting. Same root cause should
                    produce the same key (e.g. "sip_error_rate", "worker_crash:w0").
        fields: optional dict of extra key/value pairs shown as embed fields
    """
    global _no_webhook_warned

    if not DISCORD_WEBHOOK_URL:
        if not _no_webhook_warned:
            logger.warning("DISCORD_WEBHOOK_URL not set — alerts are disabled")
            _no_webhook_warned = True
        return

    now = time.time()
    async with _state_lock:
        st = _state.setdefault(dedupe_key, _AlertState())

        time_since_last = now - st.last_sent_at
        if time_since_last < ALERT_COOLDOWN_SECONDS:
            # Still in cooldown — suppress unless 30 min has passed since last
            # "firing" summary AND we've actually suppressed something.
            st.suppressed_count += 1
            since_last_summary = now - st.last_firing_summary_at
            if since_last_summary < STILL_FIRING_INTERVAL_SECONDS:
                return
            # Emit a still-firing summary
            st.last_firing_summary_at = now
            summary_body = (
                f"This alert key has been firing for "
                f"{int((now - st.last_sent_at) / 60)} minutes. "
                f"{st.suppressed_count} occurrence(s) suppressed since last notification."
            )
            payload = _build_payload("warning", f"[still firing] {title}", summary_body, fields)
            await _post_to_discord(payload)
            return

        # Fresh alert — send it and reset state
        st.last_sent_at = now
        st.last_firing_summary_at = now
        st.suppressed_count = 0

    payload = _build_payload(severity, title, body, fields)
    await _post_to_discord(payload)


def _build_payload(
    severity: str,
    title: str,
    body: str,
    fields: dict[str, str] | None,
) -> dict:
    embed: dict = {
        "title": title[:256],
        "description": _truncate(body),
        "color": _COLOR.get(severity, _COLOR["info"]),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
    }
    if fields:
        embed["fields"] = [
            {"name": k[:256], "value": str(v)[:1024], "inline": True}
            for k, v in fields.items()
        ][:25]  # Discord caps at 25 fields
    return {"embeds": [embed]}


def notify_sync_fire_and_forget(
    severity: str,
    title: str,
    body: str,
    dedupe_key: str,
    **kwargs,
) -> None:
    """Synchronous wrapper for non-async code paths.

    Schedules the notification on the running event loop if there is one;
    otherwise it's a no-op (we don't block sync code to send an alert).
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # No loop running (e.g. called from a sync cron); silently drop.
        logger.debug("notify_sync called outside event loop, skipping (key=%s)", dedupe_key)
        return
    loop.create_task(notify(severity, title, body, dedupe_key, **kwargs))
