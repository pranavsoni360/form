"""LRS API routes. Mounted at /api/lrs in main.py."""
import json
import logging
import uuid

from fastapi import APIRouter, HTTPException

logger = logging.getLogger("lrs-routes")

router = APIRouter()

_JSON_FIELDS = ("pillar_scores", "effective_weights", "raw_provider_data")


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
async def get_score(application_id: str):
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
async def rescore(application_id: str):
    """Force a re-score (officer-triggered). Runs inline and returns the result."""
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
