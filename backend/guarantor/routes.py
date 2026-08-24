# backend/guarantor/routes.py
"""Webhooks the guarantor agent posts to. No JWT (same trust model as
/api/agent/transcript). Mirrors consent onto loan_applications for display.
"""
import json
import uuid
import logging

from fastapi import APIRouter, Request
from pydantic import BaseModel
from typing import Optional, List, Any

logger = logging.getLogger("guarantor-routes")
router = APIRouter()


def _norm_consent(v: Optional[str]) -> Optional[str]:
    s = (v or "").strip().lower()
    if s in ("yes", "y", "haan", "ho", "हाँ", "हो"):
        return "yes"
    if s in ("no", "n", "nahi", "नहीं", "नाही"):
        return "no"
    return None


class ConsentPayload(BaseModel):
    call_id: str
    consent: Optional[str] = ""
    note: Optional[str] = ""


class TranscriptPayload(BaseModel):
    room: Optional[str] = None
    call_id: str
    transcript: List[Any] = []
    recording_path: Optional[str] = None
    consent: Optional[str] = ""
    consent_note: Optional[str] = ""


async def _mirror(db_pool, row_id, consent):
    app_id = await db_pool.fetchval(
        "SELECT application_id FROM guarantor_consent_calls WHERE id=$1", row_id)
    if app_id:
        await db_pool.execute(
            """UPDATE loan_applications
                 SET guarantor_consent = COALESCE($1, 'pending'),
                     guarantor_consent_at = NOW()
               WHERE id=$2""",
            consent, app_id,
        )


@router.post("/consent")
async def guarantor_consent(data: ConsentPayload, request: Request):
    from agent import state as _state
    from services import audit as _audit
    try:
        row_id = uuid.UUID(data.call_id)
    except ValueError:
        return {"status": "error", "message": "bad call_id"}
    consent = _norm_consent(data.consent)
    await _state.db_pool.execute(
        """UPDATE guarantor_consent_calls
             SET consent=$1, consent_note=$2, updated_at=NOW()
           WHERE id=$3""",
        consent, data.note or None, row_id,
    )
    await _mirror(_state.db_pool, row_id, consent)
    # DPDP consent audit — record the guarantor consent event (yes/no) against the
    # application. Best-effort; never fails the webhook.
    try:
        app_id = await _state.db_pool.fetchval(
            "SELECT application_id FROM guarantor_consent_calls WHERE id=$1", row_id)
        await _audit.record_sensitive_access(
            _state.db_pool, request, actor={"actor_type": "agent", "actor_id": None},
            action="guarantor_consent", entity_type="application",
            entity_id=(str(app_id) if app_id else None),
            details={"call_id": data.call_id, "consent": consent, "note": data.note})
    except Exception as e:
        logger.warning("guarantor consent audit failed: %s", e)
    return {"status": "ok", "consent": consent}


@router.post("/transcript")
async def guarantor_transcript(data: TranscriptPayload):
    from agent import state as _state
    from agent.state import RECORDING_BASE_URL  # reuse existing base url constant
    try:
        row_id = uuid.UUID(data.call_id)
    except ValueError:
        return {"status": "error", "message": "bad call_id"}

    recording_url = (
        f"{RECORDING_BASE_URL}{data.recording_path}"
        if data.recording_path and RECORDING_BASE_URL else None
    )
    consent = _norm_consent(data.consent)
    status = "completed" if data.transcript else "no_answer"

    await _state.db_pool.execute(
        """UPDATE guarantor_consent_calls SET
             transcript=$1, recording_url=COALESCE($2, recording_url),
             status=$3, ended_at=NOW(), updated_at=NOW(),
             consent=COALESCE($4, consent),
             consent_note=COALESCE($5, consent_note)
           WHERE id=$6""",
        json.dumps(data.transcript), recording_url, status,
        consent, (data.consent_note or None), row_id,
    )
    final_consent = await _state.db_pool.fetchval(
        "SELECT consent FROM guarantor_consent_calls WHERE id=$1", row_id)
    await _mirror(_state.db_pool, row_id, final_consent)
    return {"status": "ok", "row": str(row_id), "call_status": status}
