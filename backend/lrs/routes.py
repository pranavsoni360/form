"""LRS API routes. Mounted at /api/lrs in main.py."""
import json
import logging
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from agent.state import get_current_bank_user

logger = logging.getLogger("lrs-routes")

router = APIRouter()

_JSON_FIELDS = ("pillar_scores", "effective_weights", "raw_provider_data", "reasons", "offer_options")


def _row_to_payload(row) -> dict:
    d = dict(row)
    for k in _JSON_FIELDS:
        v = d.get(k)
        if isinstance(v, str):
            try:
                d[k] = json.loads(v)
            except (ValueError, TypeError):
                pass
    # asyncpg returns text[] as a list already; datetimes → isoformat
    for k, v in list(d.items()):
        if hasattr(v, "isoformat"):
            d[k] = v.isoformat()
        elif isinstance(v, uuid.UUID):
            d[k] = str(v)
    return d


@router.get("/score/{application_id}")
async def get_score(application_id: str, user: dict = Depends(get_current_bank_user)):
    """Return the stored LRS score for an application (or 404 if not scored yet)."""
    from agent import state as _state
    db_pool = _state.db_pool
    try:
        app_uuid = uuid.UUID(application_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid application_id")
    row = await db_pool.fetchrow(
        "SELECT * FROM lrs_scores WHERE application_id = $1", app_uuid
    )
    if not row:
        raise HTTPException(status_code=404, detail="LRS score not found")
    return _row_to_payload(row)


@router.post("/rescore/{application_id}")
async def rescore(application_id: str, user: dict = Depends(get_current_bank_user)):
    """Force a re-score against the latest active config (officer-triggered)."""
    from agent import state as _state
    db_pool = _state.db_pool
    try:
        app_uuid = uuid.UUID(application_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid application_id")
    from lrs.handlers import run_and_persist
    try:
        result = await run_and_persist(db_pool, app_uuid, force=True)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"scoring failed: {e}")
    if result is None:
        raise HTTPException(status_code=404, detail="application not found")
    return {"ok": True, "total_score": result["total_score"], "decision": result["decision"]}


# Statuses safe to bulk re-score after a scorecard change: only PRE-DECISION
# applications. Anything an officer/supervisor has already acted on
# (officer_approved / *_rejected / approved / disbursed) is deliberately left
# frozen so a config tweak can never silently flip a decision already made.
_RESCORABLE_STATUSES = ("draft", "submitted", "documents_submitted")


@router.post("/rescore-pending")
async def rescore_pending(user: dict = Depends(get_current_bank_user)):
    """Bulk re-score every already-scored, PRE-DECISION application against the
    latest active config (use after editing the scorecard). Runs async via the
    job queue with force=True; decided/disbursed applications are never touched."""
    from agent import state as _state
    from services.job_worker import enqueue_job
    db_pool = _state.db_pool
    rows = await db_pool.fetch(
        """SELECT la.id
             FROM loan_applications la
             JOIN lrs_scores l ON l.application_id = la.id
            WHERE la.status = ANY($1::text[])
            ORDER BY la.created_at DESC
            LIMIT 500""",
        list(_RESCORABLE_STATUSES),
    )
    for r in rows:
        await enqueue_job(
            db_pool, job_type="lrs_score",
            payload={"application_id": str(r["id"]), "force": True},
        )
    logger.info("rescore-pending: queued %d application(s)", len(rows))
    return {
        "ok": True,
        "queued": len(rows),
        "rescorable_statuses": list(_RESCORABLE_STATUSES),
        "note": "Approved / rejected / disbursed applications are intentionally not re-scored.",
    }


# ── Scorecard config endpoints (bank-configurable) ────────────────────────────

@router.get("/config")
async def get_config(user: dict = Depends(get_current_bank_user)):
    """Return the active scorecard config (bank-editable)."""
    from agent import state as _state
    from lrs import scorecard as sc_module
    cfg = await sc_module.get_db_config(_state.db_pool, user.get("bank_id"))
    return cfg


@router.put("/config")
async def put_config(request: Request, user: dict = Depends(get_current_bank_user)):
    """Validate and persist a new scorecard config. Takes effect immediately."""
    from agent import state as _state
    from lrs import scorecard as sc_module
    try:
        body: dict[str, Any] = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")
    try:
        if user.get("bank_id"):
            # bank editor → new live per-bank version
            await sc_module.save_bank_config(_state.db_pool, user["bank_id"], body)
        else:
            # operator/admin → the global default template new banks seed from
            await sc_module.save_db_config(_state.db_pool, body)
    except sc_module.ScorecardConfigError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {"ok": True, "config_version": body.get("config_version", "")}
