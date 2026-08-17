# backend/agent/callbacks.py
import json
import time
import secrets
import uuid
import logging
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request, Depends

from . import state as _state
from .state import (
    now_ist, IST, CALL_START_HOUR, CALL_END_HOUR,
    _serialize_call, _row_to_dict,
)

logger = logging.getLogger("agent-callbacks")
router = APIRouter()


# All manually-scheduled callbacks live under one persistent, always-'running'
# batch so the existing dispatcher/cron dials them with no new dispatch logic.
_MANUAL_BATCH_ID = "manual_callbacks"


def _to_e164_in(raw: str) -> Optional[str]:
    """Normalise an Indian phone to +91XXXXXXXXXX. Returns None if <10 digits."""
    d = "".join(ch for ch in (raw or "") if ch.isdigit())
    if len(d) == 10:
        return f"+91{d}"
    if len(d) == 11 and d.startswith("0"):
        return f"+91{d[-10:]}"
    if len(d) == 12 and d.startswith("91"):
        return f"+{d}"
    if len(d) >= 10:
        return f"+{d}"
    return None


async def _ensure_manual_batch() -> None:
    """Create the persistent manual-callbacks batch once, and keep it 'running'
    so the dispatcher always considers its due callbacks. Check-then-insert
    (agent_batches.batch_id has no UNIQUE constraint, so ON CONFLICT can't be
    used); a rare concurrent double-create is harmless — the dispatcher always
    processes the oldest 'running' batch, so due callbacks still fire."""
    existing = await _state.db_pool.fetchrow(
        "SELECT status FROM agent_batches WHERE batch_id = $1", _MANUAL_BATCH_ID
    )
    if existing is None:
        await _state.db_pool.execute(
            """INSERT INTO agent_batches (id, batch_id, filename, total_records,
                                          completed, failed, status, created_at)
               VALUES ($1, $2, 'Manual Callbacks', 0, 0, 0, 'running', $3)""",
            uuid.uuid4(), _MANUAL_BATCH_ID, now_ist(),
        )
    elif existing["status"] in ("completed", "paused"):
        await _state.db_pool.execute(
            "UPDATE agent_batches SET status = 'running' WHERE batch_id = $1",
            _MANUAL_BATCH_ID,
        )


@router.post("/schedule-callback-manual")
async def schedule_callback_manual(request: Request, user: dict = Depends(_state.get_current_bank_user)):
    """Operator-created callback: schedule a fresh outbound call to a customer at
    a chosen time. Creates a new agent_calls row (status 'Called - Callback
    Requested') under the persistent manual-callbacks batch, so the dispatcher
    re-dials it when scheduled_callback_at arrives during working hours."""
    data = await request.json()
    name = (data.get("customer_name") or "").strip()
    phone_in = (data.get("phone") or "").strip()
    callback_iso = (data.get("callback_iso") or "").strip()
    reason = (data.get("reason") or "").strip() or "manual"
    language = (data.get("language") or "hindi").strip().lower()
    agent_type = (data.get("agent_type") or "loan_enquiry").strip()

    if not name:
        raise HTTPException(status_code=400, detail="Customer name is required")
    phone = _to_e164_in(phone_in)
    if not phone:
        raise HTTPException(status_code=400, detail="Enter a valid phone number (at least 10 digits)")
    if not callback_iso:
        raise HTTPException(status_code=400, detail="Callback date/time is required")
    try:
        if callback_iso.endswith("Z"):
            callback_iso = callback_iso[:-1] + "+00:00"
        dt = datetime.fromisoformat(callback_iso)
        if dt.tzinfo is None:
            dt = IST.localize(dt)
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid date/time: {e}")

    # Clamp into [now+2min, working hours] — same rule as the agent-triggered path.
    dt_ist = dt.astimezone(IST)
    now_local = now_ist()
    if dt_ist < now_local + timedelta(minutes=1):
        dt_ist = now_local + timedelta(minutes=2)
    if dt_ist.hour < CALL_START_HOUR or dt_ist.hour >= CALL_END_HOUR:
        next_day = dt_ist.date() if dt_ist.hour < CALL_START_HOUR else (dt_ist + timedelta(days=1)).date()
        dt_ist = IST.localize(datetime.combine(next_day, datetime.min.time())).replace(hour=CALL_START_HOUR)

    await _ensure_manual_batch()

    call_uuid = uuid.uuid4()
    room_name = f"los_{secrets.token_hex(6)}_{int(time.time())}"
    await _state.db_pool.execute(
        """INSERT INTO agent_calls (
             id, batch_id, customer_name, phone, language, status, room_name,
             interested, form_sent, category, transcript, collected_data,
             scheduled_callback_at, callback_reason, created_at, updated_at, agent_type
           ) VALUES (
             $1, $2, $3, $4, $5, 'Called - Callback Requested', $6,
             false, false, 'Uncategorized', '[]'::jsonb, $7,
             $8, $9, $10, $10, $11
           )""",
        call_uuid, _MANUAL_BATCH_ID, name, phone, language, room_name,
        json.dumps({"gender": (data.get("gender") or "male").lower(), "customer_type": "callback"}),
        dt_ist, reason, now_local, agent_type,
    )

    logger.info("Manual callback scheduled: %s (%s) at %s reason=%s",
                name, phone, dt_ist.isoformat(), reason)
    return {
        "status": "success",
        "call_id": str(call_uuid),
        "customer_name": name,
        "phone": phone,
        "scheduled_callback_at": dt_ist.isoformat(),
        "reason": reason,
    }


@router.get("/scheduled-callbacks")
async def scheduled_callbacks(limit: int = Query(50, ge=1, le=200), user: dict = Depends(_state.get_current_bank_user)):
    """List upcoming scheduled callbacks ordered by callback time.
    Used by the dashboard's 'Upcoming Callbacks' section."""
    rows = await _state.db_pool.fetch(
        """SELECT * FROM agent_calls
           WHERE status IN ('Scheduled', 'Called - Callback Requested')
             AND scheduled_callback_at IS NOT NULL
           ORDER BY scheduled_callback_at ASC LIMIT $1""",
        limit,
    )
    payload = [_serialize_call(_row_to_dict(r)) for r in rows]
    return {"scheduled": payload, "count": len(payload)}


@router.post("/schedule-callback")
async def schedule_callback(request: Request):
    """Triggered by the voice agent when a customer says they are busy and asks
    to be called back at a specific time. Clamps the time into working hours,
    sets the call's status to 'Called - Callback Requested' so the batch
    dispatcher will re-dial when scheduled_callback_at arrives."""
    data = await request.json()
    call_id = data.get("call_id")
    callback_iso = data.get("callback_iso")
    reason = (data.get("reason") or "").strip() or "user_busy"

    if not call_id or not callback_iso:
        raise HTTPException(status_code=400, detail="call_id and callback_iso required")
    try:
        call_uuid = uuid.UUID(call_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid call_id")
    try:
        # Accept either naive (treated as IST) or tz-aware ISO 8601 strings
        if callback_iso.endswith("Z"):
            callback_iso = callback_iso[:-1] + "+00:00"
        dt = datetime.fromisoformat(callback_iso)
        if dt.tzinfo is None:
            dt = IST.localize(dt)
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=f"invalid callback_iso: {e}")

    # Clamp into [now+1min, working_hours]. If the requested time is in the past or
    # outside the calling window, push it to the next valid window start.
    dt_ist = dt.astimezone(IST)
    now_local = now_ist()
    if dt_ist < now_local + timedelta(minutes=1):
        dt_ist = now_local + timedelta(minutes=2)
    # If hour is outside working window, snap to next CALL_START_HOUR
    if dt_ist.hour < CALL_START_HOUR or dt_ist.hour >= CALL_END_HOUR:
        next_day = dt_ist.date() if dt_ist.hour < CALL_START_HOUR else (dt_ist + timedelta(days=1)).date()
        dt_ist = IST.localize(datetime.combine(next_day, datetime.min.time())).replace(hour=CALL_START_HOUR)

    await _state.db_pool.execute(
        """UPDATE agent_calls
           SET status = 'Called - Callback Requested',
               scheduled_callback_at = $1,
               callback_reason = $2,
               error_message = NULL,
               updated_at = $3
           WHERE id = $4""",
        dt_ist, reason, now_local, call_uuid,
    )
    # Reactivate the parent batch so the dispatcher will pick this row up when
    # scheduled_callback_at arrives. Flip 'completed' OR 'paused' → 'running'.
    # 'paused' can happen if the operator hit emergency-stop during the original
    # batch — without this fix, the callback silently never fires.
    row = await _state.db_pool.fetchrow("SELECT batch_id FROM agent_calls WHERE id = $1", call_uuid)
    if row and row["batch_id"]:
        await _state.db_pool.execute(
            """UPDATE agent_batches
               SET status = 'running'
               WHERE batch_id = $1
                 AND status IN ('completed', 'paused')""",
            row["batch_id"],
        )

    logger.info(f"Callback scheduled for {call_uuid} at {dt_ist.isoformat()} (reason={reason})")
    return {
        "status": "success",
        "scheduled_callback_at": dt_ist.isoformat(),
        "reason": reason,
    }
