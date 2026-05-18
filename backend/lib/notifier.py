"""
Telegram bot alerts with rate-limited token bucket.

Why rate limiting:
- During an incident, the same root cause can trigger hundreds of similar
  errors. Without rate limiting, the alert channel becomes unreadable noise.
- Token bucket per `dedupe_key`: 1 alert / 5 min / key. After 30 min we emit
  a "still firing" summary so you know the issue persists.

Why Telegram:
- Operator's preference — alerts go to a Telegram chat the team already uses.
- Telegram bot API: free, no per-message rate limits at this volume, no
  webhook gymnastics. Just a bot token + chat_id.

Usage:
    from lib.notifier import notify
    await notify(
        severity="critical",
        title="Job worker died",
        body="JobWorker w0 crashed: ConnectionError to Postgres",
        dedupe_key="worker_crash:w0",
        fields={"worker": "w0", "host": "voice-ops-1"},
    )

Setup:
1. Open Telegram → search @BotFather → /newbot → save the TOKEN
2. Send /start to your new bot
3. Visit https://api.telegram.org/bot<TOKEN>/getUpdates → find chat.id
4. Put in .env:
     TELEGRAM_BOT_TOKEN=7654321098:AAEx...K9wQ
     TELEGRAM_CHAT_ID=123456789      (or -100... for a group)

If TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are unset, this becomes a no-op
(logs a warning once on startup). The application boots fine without alerts
configured — useful for local dev.
"""

from __future__ import annotations

import asyncio
import html
import logging
import os
import time
from dataclasses import dataclass

import httpx


logger = logging.getLogger(__name__)

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "").strip()

# Token-bucket window: minimum gap between alerts with the SAME dedupe_key.
ALERT_COOLDOWN_SECONDS = 300       # 5 minutes
# After this many seconds of continuous firing, send a "still firing" summary.
STILL_FIRING_INTERVAL_SECONDS = 1800  # 30 minutes

# Telegram message-body cap is 4096 chars; we stay conservative under that
# so HTML overhead + emoji never push us over.
MAX_BODY_LEN = 3500

# Severity → emoji prefix (Telegram doesn't do embed colors).
_EMOJI = {
    "info":     "ℹ️",
    "warning":  "⚠️",
    "critical": "🚨",
}


@dataclass
class _AlertState:
    last_sent_at: float = 0.0
    last_firing_summary_at: float = 0.0
    suppressed_count: int = 0


_state: dict[str, _AlertState] = {}
_state_lock = asyncio.Lock()
_no_token_warned = False


def _truncate(s: str, n: int = MAX_BODY_LEN) -> str:
    if len(s) <= n:
        return s
    return s[: n - 20] + "\n…(truncated)"


def _build_text(
    severity: str,
    title: str,
    body: str,
    fields: dict[str, str] | None,
) -> str:
    """Build a Telegram HTML message body. Uses html.escape() on user-supplied
    strings so a stack trace with '<' or '&' doesn't break Telegram's parser."""
    emoji = _EMOJI.get(severity, _EMOJI["info"])
    parts: list[str] = [f"{emoji} <b>{html.escape(title)}</b>", ""]
    if body:
        parts.append(html.escape(_truncate(body)))
    if fields:
        parts.append("")
        for k, v in list(fields.items())[:25]:
            parts.append(f"<b>{html.escape(str(k))}:</b> <code>{html.escape(str(v))}</code>")
    parts.append("")
    parts.append(f"<i>⏰ {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}</i>")
    return "\n".join(parts)


async def _send_to_telegram(text: str) -> None:
    """POST sendMessage to Telegram. Errors logged but never raised — alerting
    must never block or crash the caller."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(url, json=payload)
            if resp.status_code >= 400:
                logger.warning(
                    "Telegram sendMessage returned %d: %s",
                    resp.status_code, resp.text[:200],
                )
    except Exception as e:
        logger.warning("Telegram sendMessage failed: %s", e)


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
        title: short headline
        body: details, stack traces, etc. (truncated to ~3500 chars)
        dedupe_key: stable string for rate limiting. Same root cause should
                    produce the same key (e.g. "sip_error_rate", "worker_crash:w0").
        fields: optional dict of extra key/value pairs shown as bold lines
    """
    global _no_token_warned

    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        if not _no_token_warned:
            logger.warning(
                "TELEGRAM_BOT_TOKEN/CHAT_ID not set — alerts are disabled"
            )
            _no_token_warned = True
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
            text = _build_text(
                "warning",
                f"[still firing] {title}",
                summary_body,
                fields,
            )
            await _send_to_telegram(text)
            return

        # Fresh alert — send it and reset state
        st.last_sent_at = now
        st.last_firing_summary_at = now
        st.suppressed_count = 0

    text = _build_text(severity, title, body, fields)
    await _send_to_telegram(text)


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
