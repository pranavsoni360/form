"""
Registered handlers for `call_processing_jobs`.

Each handler is async, takes (payload: dict, db_pool: asyncpg.Pool) and:
- Returns normally on success (worker marks job 'done')
- Raises on transient failure (worker retries with exponential backoff)
- Raises NotImplementedError if not yet wired (worker marks 'dead' without retry)

Wired in M3:
- transcript_analyze: runs Gemini categorization on a finished call

Stubbed (wired later):
- whatsapp_send_retry: re-attempts a failed AiSensy send. Wired in M5 alongside
  the circuit breaker so the producer side and handler ship together.
- recording_verify: confirms LiveKit egress wrote the .ogg file. Wired in M8
  alongside the recording-archive pipeline.
- recording_archive_b2: uploads /recordings/*.ogg to Backblaze B2. Wired in M8.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

import asyncpg


logger = logging.getLogger(__name__)


# ============================================================================
# transcript_analyze  (FULLY WIRED in M3)
# ============================================================================

async def transcript_analyze(payload: dict, db_pool: asyncpg.Pool) -> None:
    """Run Gemini categorization on a single call, merging into call_analysis.

    payload: {"call_id": "<uuid string>"}

    Idempotency: skip if `category` is already set to something other than
    'Uncategorized' (or empty). This protects against re-enqueue from both the
    transcript webhook and the analytics cron landing simultaneously.
    """
    # Import lazily so this module stays import-cheap and avoids circular
    # imports against backend.agent.analytics (which itself may want to enqueue).
    from agent.analytics import analyze_transcript_with_llm
    from agent.state import now_ist, _row_to_dict

    call_id_str = payload.get("call_id")
    if not call_id_str:
        raise ValueError("transcript_analyze: payload missing 'call_id'")

    try:
        call_uuid = uuid.UUID(call_id_str)
    except (ValueError, TypeError) as e:
        raise ValueError(f"transcript_analyze: invalid call_id {call_id_str!r}") from e

    row = await db_pool.fetchrow(
        "SELECT * FROM agent_calls WHERE id = $1",
        call_uuid,
    )
    if row is None:
        logger.warning("transcript_analyze: call %s not found (deleted?)", call_uuid)
        return  # Treat as done — no retry will help

    call = _row_to_dict(row)

    # Idempotency guard: don't re-analyze a call that's already been categorized.
    current_category = (call.get("category") or "").strip()
    if current_category and current_category != "Uncategorized":
        logger.info(
            "transcript_analyze: call %s already categorized as %r; skipping",
            call_uuid, current_category,
        )
        return

    transcript = call.get("transcript") or []
    if isinstance(transcript, str):
        try:
            transcript = json.loads(transcript)
        except json.JSONDecodeError:
            transcript = []
    if not transcript:
        logger.info("transcript_analyze: call %s has empty transcript; skipping", call_uuid)
        return

    # The LLM call is blocking; run it in a thread so we don't pin the worker
    # event loop. Gemini SDK is not natively async.
    import asyncio
    analysis: dict[str, Any] = await asyncio.to_thread(analyze_transcript_with_llm, transcript)

    existing = call.get("call_analysis") or {}
    if isinstance(existing, str):
        try:
            existing = json.loads(existing)
        except json.JSONDecodeError:
            existing = {}
    merged = dict(existing) if isinstance(existing, dict) else {}

    for k, v in {
        "follow_up_needed": analysis.get("follow_up_needed", "No"),
        "reminder_date":    analysis.get("reminder_date"),
        "how_to_follow_up": analysis.get("how_to_follow_up"),
        "when_to_follow_up": analysis.get("when_to_follow_up"),
        # Don't clobber an agent-set lead_quality with a None from the LLM
        "lead_quality":     analysis.get("lead_quality") or merged.get("lead_quality"),
        "summary":          f"Category: {analysis.get('category')} | Follow-up: {analysis.get('follow_up_needed')}",
    }.items():
        if v is not None:
            merged[k] = v

    await db_pool.execute(
        """UPDATE agent_calls
           SET category = $1,
               call_analysis = $2::jsonb,
               updated_at = $3
           WHERE id = $4""",
        analysis.get("category", "Uncategorized"),
        json.dumps(merged),
        now_ist(),
        call_uuid,
    )
    logger.info("transcript_analyze: call %s → %s", call_uuid, analysis.get("category"))


# ============================================================================
# Stubs — wired in later milestones
# ============================================================================

async def whatsapp_send_retry(payload: dict, db_pool: asyncpg.Pool) -> None:
    """Re-attempt a failed AiSensy send.

    payload: {"to": "+91...", "template": "LRS_TESTING", "vars": {...},
              "idempotency_key": "<uuid>"}

    Wired in M5 alongside circuit breaker for AiSensy.
    """
    raise NotImplementedError("whatsapp_send_retry handler is wired in M5")


async def recording_verify(payload: dict, db_pool: asyncpg.Pool) -> None:
    """Confirm LiveKit egress wrote the .ogg file; otherwise requeue.

    payload: {"call_id": "<uuid>", "egress_id": "EG_...", "expected_path": "/recordings/<room>.ogg"}

    Wired in M8 alongside recording_archive_b2.
    """
    raise NotImplementedError("recording_verify handler is wired in M8")


async def recording_archive_b2(payload: dict, db_pool: asyncpg.Pool) -> None:
    """Upload /recordings/<room>.ogg to Backblaze B2 and mark archived.

    payload: {"call_id": "<uuid>", "local_path": "/recordings/<room>.ogg"}

    Wired in M8 — needs B2 credentials and rclone setup first.
    """
    raise NotImplementedError("recording_archive_b2 handler is wired in M8")


# ============================================================================
# Registry — single source of truth for what the worker pool can run.
# ============================================================================

HANDLERS = {
    "transcript_analyze":    transcript_analyze,
    "whatsapp_send_retry":   whatsapp_send_retry,
    "recording_verify":      recording_verify,
    "recording_archive_b2":  recording_archive_b2,
}
