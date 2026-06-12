# backend/guarantor/dispatch.py
"""Dispatch ONE guarantor consent call. Mirrors the customer dispatcher's
acquire→dispatch→SIP→wait→RELEASE shape, but on the isolated guarantor table.

CRITICAL: the trunk MUST be released in `finally` (decrement active_calls),
else the shared phone pool leaks capacity and customer calls get starved.

Retry policy lives in the RUNNER, not here. This module owns exactly one call's
lifecycle: claim (increment attempt) -> place -> wait for the webhook to record
the outcome -> release the trunk. If the webhook never finalizes (true hang /
timeout) or the call can't be placed, we mark the row 'failed' (guarded so we
never clobber a webhook-set terminal) and the runner decides whether to retry.
"""
import os
import json
import time
import uuid
import asyncio
import logging

from livekit import api

from services.dispatcher import _acquire_trunk_from_db, _release_trunk_to_db

logger = logging.getLogger("guarantor-dispatch")

GUARANTOR_AGENT_NAME = os.getenv("GUARANTOR_AGENT_NAME", "guarantor-consent")
_WAIT_TIMEOUT_S = 370           # > agent safety_timeout (360s) so we never release mid-call
_POLL_INTERVAL_S = 3


async def _claim(db_pool, row_id) -> bool:
    """Atomic claim: only one runner tick wins pending->calling. Increments
    retry_count so it always reflects the number of dial attempts made."""
    claimed = await db_pool.fetchval(
        """UPDATE guarantor_consent_calls
             SET status='calling', retry_count=retry_count+1,
                 started_at=NOW(), updated_at=NOW()
           WHERE id=$1 AND status='pending'
        RETURNING id""",
        row_id,
    )
    return claimed is not None


async def _mark_failed_if_calling(db_pool, row_id) -> None:
    """Mark 'failed' ONLY if still 'calling' (i.e. the webhook never finalized).
    Guarded so a webhook-set terminal (completed/no_answer) is never clobbered.
    The runner owns whether this gets retried."""
    await db_pool.execute(
        """UPDATE guarantor_consent_calls
             SET status='failed', ended_at=NOW(), updated_at=NOW()
           WHERE id=$1 AND status='calling'""",
        row_id,
    )


async def _wait_terminal(db_pool, row_id) -> str:
    """Poll until the webhook moves the row to a terminal state, or timeout."""
    deadline = time.monotonic() + _WAIT_TIMEOUT_S
    while time.monotonic() < deadline:
        st = await db_pool.fetchval("SELECT status FROM guarantor_consent_calls WHERE id=$1", row_id)
        if st in ("completed", "no_answer", "failed"):
            return st
        await asyncio.sleep(_POLL_INTERVAL_S)
    return "timeout"


async def dispatch_guarantor_call(db_pool, row: dict) -> None:
    row_id = row["id"]
    if not await _claim(db_pool, row_id):
        return  # another tick took it

    lk = api.LiveKitAPI(
        url=os.environ["LIVEKIT_URL"],
        api_key=os.environ["LIVEKIT_API_KEY"],
        api_secret=os.environ["LIVEKIT_API_SECRET"],
    )
    trunk = await _acquire_trunk_from_db(db_pool)
    success = False
    try:
        if not trunk:
            logger.error("No trunk available for guarantor call %s", row_id)
            await _mark_failed_if_calling(db_pool, row_id)
            return

        room_name = f"gcc_{uuid.uuid4().hex[:6]}_{int(time.time())}"
        phone = str(row["guarantor_phone"])
        sip_phone = phone if phone.startswith("+") else f"+91{phone[-10:]}"
        name = row["guarantor_name"] or "Guarantor"

        await lk.room.create_room(api.CreateRoomRequest(
            name=room_name, empty_timeout=300, max_participants=3,
            metadata=json.dumps({
                "customer_name": name,                 # greeting target = guarantor
                "phone": phone,
                "call_id": str(row_id),
                "bank_id": str(row["bank_id"] or ""),
                "language": row["language"] or "hindi",
                "gender": "male",
                "agent_purpose": "guarantor_consent",
                "bank_name": row["bank_name"] or "ABC Bank",
                "borrower_name": row["borrower_name"] or "",
                "loan_amount": str(row["loan_amount"] or ""),
            }),
        ))
        await db_pool.execute(
            "UPDATE guarantor_consent_calls SET room_name=$1, updated_at=NOW() WHERE id=$2",
            room_name, row_id,
        )
        await lk.agent_dispatch.create_dispatch(
            api.CreateAgentDispatchRequest(room=room_name, agent_name=GUARANTOR_AGENT_NAME))

        sip_kwargs = dict(
            room_name=room_name, sip_trunk_id=trunk["trunk_id"], sip_call_to=sip_phone,
            participant_identity=f"guarantor_{name.replace(' ', '_').replace('/', '_')}",
            participant_name=name, play_ringtone=True,
        )
        if trunk.get("phone_number"):
            sip_kwargs["sip_number"] = trunk["phone_number"]
        await lk.sip.create_sip_participant(api.CreateSIPParticipantRequest(**sip_kwargs))

        terminal = await _wait_terminal(db_pool, row_id)
        if terminal == "completed":
            success = True
        elif terminal in ("no_answer", "failed"):
            pass  # webhook already recorded the outcome
        else:  # timeout — webhook never finalized
            await _mark_failed_if_calling(db_pool, row_id)
    except Exception as e:
        logger.error("Guarantor dispatch error %s: %s", row_id, e, exc_info=True)
        await _mark_failed_if_calling(db_pool, row_id)
    finally:
        if trunk:
            try:
                await _release_trunk_to_db(db_pool, trunk, success=success)
            except Exception as e:
                logger.error("Trunk release failed for %s: %s", row_id, e)
        try:
            await lk.aclose()
        except Exception:
            pass
