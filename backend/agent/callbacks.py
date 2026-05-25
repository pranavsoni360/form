# backend/agent/callbacks.py
import uuid
import logging
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request

from . import state as _state
from .state import (
    now_ist, IST, CALL_START_HOUR, CALL_END_HOUR,
    _serialize_call, _row_to_dict,
)

logger = logging.getLogger("agent-callbacks")
router = APIRouter()


@router.get("/scheduled-callbacks")
async def scheduled_callbacks(limit: int = Query(50, ge=1, le=200)):
    """List upcoming scheduled callbacks ordered by callback time.
    Used by the dashboard's 'Upcoming Callbacks' section."""
    rows = await _state.db_pool.fetch(
        """SELECT * FROM agent_calls
           WHERE status = 'Scheduled' AND scheduled_callback_at IS NOT NULL
           ORDER BY scheduled_callback_at ASC LIMIT $1""",
        limit,
    )
    payload = [_serialize_call(_row_to_dict(r)) for r in rows]
    return {"scheduled": payload, "count": len(payload)}


@router.post("/schedule-callback")
async def schedule_callback(request: Request):
    """Triggered by the voice agent when a customer says they are busy and asks
    to be called back at a specific time. Clamps the time into working hours,
    sets the call's status to 'Scheduled' so the batch dispatcher will re-dial."""
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
           SET status = 'Scheduled',
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
