# backend/agent/calls.py
# Call listing, CRUD, recording, categorization, form integration,
# dashboard stats, analytics summary, exports, live-status, stale-cleanup.
import io
import json
import uuid
import logging
from datetime import datetime, timedelta
from typing import Optional

import pandas as pd
from fastapi import APIRouter, HTTPException, Query, Depends, Request
from fastapi.responses import StreamingResponse

from . import state as _state
from .state import (
    now_ist, format_ist_time, IST,
    _row_to_dict, _rows_to_list, _serialize_call,
    get_current_bank_user, _bank_uuid, _rows_affected, STATUS_OPTIONS, CATEGORY_OPTIONS,
    CallCategorizeRequest, is_within_calling_hours,
    CALL_START_HOUR, CALL_END_HOUR, release_batch_lock,
)

from services import audit as _audit
from services import ratelimit as _ratelimit

logger = logging.getLogger("agent-calls")
router = APIRouter()


def _ist_midnight(date_str: str) -> datetime:
    """Parse a YYYY-MM-DD date as IST midnight (tz-aware).

    created_at is a timestamptz and the UI shows the "When" column in IST, so a
    date filter must define the day in IST too — otherwise a naive/UTC midnight
    range is offset by 5.5h and records near the boundary leak into the adjacent
    date (e.g. filtering 01-Aug also returned 02-Aug rows). NOTE: pytz needs
    localize(); a plain replace(tzinfo=IST) applies a wrong +05:53 LMT offset.
    """
    return IST.localize(datetime.strptime(date_str, "%Y-%m-%d"))


def _date_range_bounds(date_from: Optional[str], date_to: Optional[str],
                       date: Optional[str] = None):
    """Resolve a date filter into (lo, hi) IST-midnight datetimes for a
    half-open [lo, hi) window. A range wins over the single `date`; date_to is
    inclusive of that whole day (so hi = date_to + 1 day). Any unparseable value
    is ignored (returns None for that side). Returns (None, None) when nothing
    valid was supplied."""
    def _p(d):
        if not d:
            return None
        try:
            return _ist_midnight(d)
        except ValueError:
            return None

    if date_from or date_to:
        lo = _p(date_from)
        hi_day = _p(date_to)
        hi = (hi_day + timedelta(days=1)) if hi_day is not None else None
        return lo, hi
    d = _p(date)
    if d is not None:
        return d, d + timedelta(days=1)
    return None, None


# ============================================================================
# ALIAS ENDPOINTS (reference UI compatibility)
# ============================================================================

@router.get("/call/{call_id}")
async def get_call_alias(call_id: str, user: dict = Depends(get_current_bank_user)):
    """Alias for /calls/{call_id} (reference UI compatibility)."""
    try:
        call_uuid = uuid.UUID(call_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid call ID format")
    bank_uuid = _bank_uuid(user)
    row = await _state.db_pool.fetchrow(
        "SELECT * FROM agent_calls WHERE id = $1 AND ($2::uuid IS NULL OR bank_id = $2)",
        call_uuid, bank_uuid,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Call not found")
    result = _serialize_call(_row_to_dict(row))
    try:
        gconsent = await _state.db_pool.fetchval(
            "SELECT guarantor_consent FROM loan_applications"
            " WHERE agent_call_id = $1 ORDER BY last_saved_at DESC NULLS LAST LIMIT 1",
            call_uuid,
        )
        result["guarantor_consent"] = gconsent
    except Exception:
        logger.exception("Failed to fetch guarantor_consent for call %s", call_id)
    return result

@router.get("/call/{call_id}/transcript")
async def get_call_transcript_alias(call_id: str, user: dict = Depends(get_current_bank_user)):
    """Alias for /calls/{call_id}/transcript (reference UI compatibility)."""
    try:
        call_uuid = uuid.UUID(call_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid call ID format")
    bank_uuid = _bank_uuid(user)
    row = await _state.db_pool.fetchrow(
        "SELECT id, customer_name, phone, transcript FROM agent_calls WHERE id = $1 AND ($2::uuid IS NULL OR bank_id = $2)",
        call_uuid, bank_uuid,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Call not found")
    call = _row_to_dict(row)
    transcript = call.get("transcript") or []
    if isinstance(transcript, str):
        transcript = json.loads(transcript)
    return {"call_id": call_id, "name": call.get("customer_name"), "transcript": transcript}


# ============================================================================
# CALL LISTING
# ============================================================================

@router.get("/calls")
async def list_calls(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    status: Optional[str] = None,
    category: Optional[str] = None,
    batch_id: Optional[str] = None,
    date: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    lead_quality: Optional[str] = None,
    form_sent: Optional[str] = None,
    search: Optional[str] = None,
    user: dict = Depends(get_current_bank_user),
):
    """List calls with pagination and filters. Bank-scoped if authenticated, all calls for operators."""
    bank_uuid = _bank_uuid(user)  # operator (admin) -> None (all banks); bank_user -> their bank
    conditions = []
    params: list = []
    idx = 1
    if bank_uuid:
        conditions.append(f"bank_id = ${idx}")
        params.append(bank_uuid)
        idx += 1

    if status:
        # "Failed" is the umbrella for all hard-failure outcomes (Failed +
        # Invalid Phone + Call Not Connected), so counts/filters/exports match
        # the batch dashboards and Call Logs. Specific sub-statuses (e.g.
        # "Invalid Phone") still filter exactly when selected.
        if status == "Failed":
            conditions.append(f"status = ANY(${idx}::text[])")
            params.append(["Failed", "Invalid Phone", "Call Not Connected"])
        else:
            conditions.append(f"status = ${idx}")
            params.append(status)
        idx += 1
    if category:
        conditions.append(f"category = ${idx}")
        params.append(category)
        idx += 1
    if batch_id:
        conditions.append(f"batch_id = ${idx}")
        params.append(batch_id)
        idx += 1
    if lead_quality:
        conditions.append(f"call_analysis->>'lead_quality' = ${idx}")
        params.append(lead_quality)
        idx += 1
    if form_sent in ("yes", "true"):
        conditions.append("form_sent = true")
    elif form_sent in ("no", "false"):
        conditions.append("form_sent = false")
    # Server-side name/phone search (OPS-06). Was client-only over the current
    # page, so a match on another page was invisible and the count never reflected
    # it. Partial, case-insensitive; the single placeholder is referenced twice.
    if search and search.strip():
        conditions.append(f"(customer_name ILIKE ${idx} OR phone ILIKE ${idx})")
        params.append(f"%{search.strip()}%")
        idx += 1
    # Date filtering. A range (date_from/date_to, inclusive of both days) takes
    # precedence over the single `date` param (kept for backward compat with
    # ops/calls). We filter on the SAME instant the UI shows in "When" —
    # started_at, falling back to created_at — so the filter and the displayed
    # date stay in lockstep (a batch call is inserted at upload time but dialed
    # later, sometimes the next day; filtering created_at while displaying
    # started_at made a call show under one date while its "When" showed the
    # next). Boundaries are IST midnights.
    lo, hi = _date_range_bounds(date_from, date_to, date)
    if lo is not None:
        conditions.append(f"COALESCE(started_at, created_at) >= ${idx}")
        params.append(lo)
        idx += 1
    if hi is not None:
        conditions.append(f"COALESCE(started_at, created_at) < ${idx}")
        params.append(hi)
        idx += 1

    where = " AND ".join(conditions) if conditions else "TRUE"
    total = await _state.db_pool.fetchval(f"SELECT COUNT(*) FROM agent_calls WHERE {where}", *params)
    offset = (page - 1) * page_size

    rows = await _state.db_pool.fetch(
        f"""SELECT * FROM agent_calls WHERE {where}
            ORDER BY created_at DESC
            LIMIT ${idx} OFFSET ${idx + 1}""",
        *params, page_size, offset,
    )
    calls = [_serialize_call(_row_to_dict(r)) for r in rows]

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": (total + page_size - 1) // page_size,
        "calls": calls,
    }


# ============================================================================
# CALL CRUD
# ============================================================================

@router.get("/calls/{call_id}")
async def get_call(call_id: str, user: dict = Depends(get_current_bank_user)):
    """Get single call detail."""
    try:
        call_uuid = uuid.UUID(call_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid call ID format")

    bank_uuid = _bank_uuid(user)  # operator (admin) -> None (all banks); bank_user -> their bank
    row = await _state.db_pool.fetchrow(
        "SELECT * FROM agent_calls WHERE id = $1 AND ($2::uuid IS NULL OR bank_id = $2)",
        call_uuid, bank_uuid,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Call not found")
    return _serialize_call(_row_to_dict(row))


@router.get("/calls/{call_id}/transcript")
async def get_call_transcript(call_id: str, user: dict = Depends(get_current_bank_user)):
    """Get transcript for a specific call."""
    try:
        call_uuid = uuid.UUID(call_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid call ID format")

    bank_uuid = _bank_uuid(user)  # operator (admin) -> None (all banks); bank_user -> their bank
    row = await _state.db_pool.fetchrow(
        "SELECT id, customer_name, phone, transcript FROM agent_calls WHERE id = $1 AND ($2::uuid IS NULL OR bank_id = $2)",
        call_uuid, bank_uuid,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Call not found")
    call = _row_to_dict(row)
    return {
        "call_id": call_id,
        "name": call.get("customer_name"),
        "phone": call.get("phone"),
        "transcript": call.get("transcript", []),
    }


@router.get("/calls/{call_id}/recording")
async def get_call_recording(call_id: str, request: Request, user: dict = Depends(get_current_bank_user)):
    """Get recording URL for a call."""
    try:
        call_uuid = uuid.UUID(call_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid call ID format")

    bank_uuid = _bank_uuid(user)  # operator (admin) -> None (all banks); bank_user -> their bank
    row = await _state.db_pool.fetchrow(
        "SELECT id, customer_name, recording_url FROM agent_calls WHERE id = $1 AND ($2::uuid IS NULL OR bank_id = $2)",
        call_uuid, bank_uuid,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Call not found")
    call = _row_to_dict(row)
    if call.get("recording_url"):
        await _audit.record_sensitive_access(
            _state.db_pool, request, actor=_audit.decode_actor(request), action="view_recording",
            entity_type="agent_call", entity_id=call_id)
    return {
        "call_id": call_id,
        "name": call.get("customer_name"),
        "recording_url": call.get("recording_url"),
    }


@router.put("/calls/{call_id}/categorize")
async def categorize_call(
    call_id: str,
    data: CallCategorizeRequest,
    user: dict = Depends(get_current_bank_user),
):
    """Manually categorize / remark a call."""
    try:
        call_uuid = uuid.UUID(call_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid call ID format")

    bank_uuid = _bank_uuid(user)  # operator (admin) -> None (all banks); bank_user -> their bank

    # Build the update -- merge remark into call_analysis JSONB
    existing = await _state.db_pool.fetchrow(
        "SELECT call_analysis FROM agent_calls WHERE id = $1",
        call_uuid,
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Call not found")

    analysis = existing["call_analysis"] or {}
    if isinstance(analysis, str):
        analysis = json.loads(analysis)
    if data.reminder_date:
        analysis["reminder_date"] = data.reminder_date
    if data.after_call_remark:
        analysis["after_call_remark"] = data.after_call_remark

    # `IS NOT DISTINCT FROM` read as "NULL matches NULL, so operators see
    # everything" — but for an operator ($5 = NULL) it matches ONLY rows whose
    # bank_id IS NULL, i.e. the exact opposite of cross-bank access. Use the
    # explicit idiom: NULL means no filter.
    _u = await _state.db_pool.execute(
        """UPDATE agent_calls
           SET category = $1, call_analysis = $2, updated_at = $3
           WHERE id = $4 AND ($5::uuid IS NULL OR bank_id = $5)""",
        data.category, json.dumps(analysis), now_ist(), call_uuid, bank_uuid,
    )
    # The read above is unscoped (it only fetches call_analysis), so without this
    # check a cross-tenant attempt updated nothing and still returned
    # {"status": "updated"} — a false success and an existence oracle.
    if _rows_affected(_u) == 0:
        raise HTTPException(status_code=404, detail="Call not found")
    return {"status": "updated", "call_id": call_id}


# ============================================================================
# FORM INTEGRATION ENDPOINTS
# ============================================================================

@router.get("/form-data/{call_id}")
async def get_form_data(call_id: str):
    """Return collected lead data for pre-filling a loan form. Public (no auth) so
    the customer can access the form link sent via WhatsApp."""
    try:
        call_uuid = uuid.UUID(call_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid call ID")

    row = await _state.db_pool.fetchrow("SELECT * FROM agent_calls WHERE id = $1", call_uuid)
    if not row:
        raise HTTPException(status_code=404, detail="Lead not found")
    call = _row_to_dict(row)
    collected = call.get("collected_data") or {}
    if isinstance(collected, str):
        try:
            collected = json.loads(collected)
        except Exception:
            collected = {}
    ca = call.get("call_analysis") or {}
    if isinstance(ca, str):
        try:
            ca = json.loads(ca)
        except Exception:
            ca = {}

    return {
        "status": "success",
        "data": {
            "customer_name": call.get("customer_name", ""),
            "phone": call.get("phone", ""),
            "email": collected.get("email", ""),
            "aadhar_number": collected.get("aadhar_number", ""),
            "pan_number": collected.get("pan_number", ""),
            "customer_type": collected.get("customer_type", "new"),
            "loan_type": call.get("loan_type", ""),
            "loan_amount": call.get("loan_amount", ""),
            "employment_type": collected.get("employment_type", ""),
            "employer_name": collected.get("employer_name", ""),
            "monthly_income": collected.get("monthly_income", ""),
            "business_type": collected.get("business_type", ""),
            "age": collected.get("age", ""),
            "address": collected.get("collected_address", ""),
            "designation": collected.get("designation", ""),
            "loan_purpose": collected.get("loan_purpose", ""),
            "account_type":    collected.get("account_type", ""),
            "initial_deposit": collected.get("initial_deposit", ""),
            "agent_type":      call.get("agent_type", "loan_enquiry"),
            "lead_quality": ca.get("lead_quality", ""),
            "call_status": call.get("status", ""),
            "bank_id": call.get("bank_id", ""),
        },
    }


@router.post("/submit-form/{call_id}")
async def submit_form(call_id: str, request: Request):
    """Receive submitted form data and update the lead record. Public endpoint."""
    try:
        call_uuid = uuid.UUID(call_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid call ID")

    data = await request.json()
    row = await _state.db_pool.fetchrow("SELECT * FROM agent_calls WHERE id = $1", call_uuid)
    if not row:
        raise HTTPException(status_code=404, detail="Lead not found")
    call = _row_to_dict(row)

    # Merge form data into collected_data
    existing_collected = call.get("collected_data") or {}
    if isinstance(existing_collected, str):
        existing_collected = json.loads(existing_collected)
    existing_collected.update({
        "email": data.get("email") or existing_collected.get("email", ""),
        "age": data.get("age") or existing_collected.get("age", ""),
        "collected_address": data.get("address") or existing_collected.get("collected_address", ""),
        "aadhar_number": data.get("aadhar_number") or existing_collected.get("aadhar_number", ""),
        "pan_number": data.get("pan_number") or existing_collected.get("pan_number", ""),
        "employment_type": data.get("employment_type") or existing_collected.get("employment_type", ""),
        "monthly_income": data.get("monthly_income") or existing_collected.get("monthly_income", ""),
        "employer_name": data.get("employer_name") or existing_collected.get("employer_name", ""),
        "designation": data.get("designation") or existing_collected.get("designation", ""),
        "loan_purpose": data.get("loan_purpose") or existing_collected.get("loan_purpose", ""),
        "form_submitted": True,
        "form_submission_time": now_ist().isoformat(),
        "otp_verified": data.get("otp_verified", False),
        "form_data": data,
    })

    # Update call_analysis to mark as hot lead
    existing_analysis = call.get("call_analysis") or {}
    if isinstance(existing_analysis, str):
        existing_analysis = json.loads(existing_analysis)
    existing_analysis["lead_quality"] = "hot"

    await _state.db_pool.execute(
        """UPDATE agent_calls SET
            loan_type = COALESCE($1, loan_type),
            loan_amount = COALESCE($2, loan_amount),
            collected_data = $3,
            call_analysis = $4,
            form_sent = true,
            updated_at = $5
           WHERE id = $6""",
        data.get("loan_type") or None,
        float(data["loan_amount"]) if data.get("loan_amount") and str(data["loan_amount"]).strip() else None,
        json.dumps(existing_collected),
        json.dumps(existing_analysis),
        now_ist(),
        call_uuid,
    )
    logger.info(f"Form submitted for lead {call_id} - {call.get('customer_name', 'Unknown')}")
    return {"status": "success", "message": "Application submitted successfully"}


# ============================================================================
# DASHBOARD STATS & ANALYTICS SUMMARY
# ============================================================================

@router.get("/dashboard-stats")
async def get_dashboard_stats(
    date: Optional[str] = None,
    user: dict = Depends(get_current_bank_user),
):
    """Dashboard statistics (bank-scoped for bank users, all banks for operators)."""
    date_clause = ""
    params: list = []
    idx = 1

    bank_uuid = _bank_uuid(user)  # operator -> None (all banks); bank_user -> their bank
    bank_clause = ""
    if bank_uuid:
        bank_clause = f" AND bank_id = ${idx}"
        params.append(bank_uuid)
        idx += 1

    if date:
        try:
            dt = _ist_midnight(date)
            date_clause = f" AND created_at >= ${idx} AND created_at < ${idx + 1}"
            params.append(dt)
            params.append(dt + timedelta(days=1))
            idx += 2
        except ValueError:
            pass

    where = f"WHERE TRUE{bank_clause}{date_clause}"

    # One pass for every headline counter. This used to be nine separate
    # COUNT(*) round-trips over the same rows with the same WHERE, and the two
    # breakdowns below added one more per status and per category — about 29
    # scans of agent_calls per dashboard load. Under load that was the slowest
    # endpoint in the API by a wide margin (p99 ~1.9s at 60 concurrent).
    # COUNT(*) FILTER gives identical numbers from a single scan.
    agg = await _state.db_pool.fetchrow(
        f"""SELECT
              COUNT(*)                                                        AS total,
              COUNT(*) FILTER (WHERE form_sent = true)                        AS forms_sent,
              COUNT(*) FILTER (WHERE call_analysis->>'lead_quality' = 'hot')  AS hot,
              COUNT(*) FILTER (WHERE call_analysis->>'lead_quality' = 'warm') AS warm,
              COUNT(*) FILTER (WHERE status = 'Pending')                      AS pending,
              COUNT(*) FILTER (WHERE status IN ('Not Answered', 'Failed',
                                                'Invalid Phone', 'Call Not Connected')) AS not_answered,
              COUNT(*) FILTER (WHERE loan_type = 'education')                 AS education,
              COUNT(*) FILTER (WHERE loan_type = 'business')                  AS business,
              COUNT(*) FILTER (WHERE loan_type = 'personal')                  AS personal
            FROM agent_calls {where}""",
        *params,
    )

    stats = {
        "total_calls": agg["total"],
        "whatsapp_forms_sent": agg["forms_sent"],
        "hot_leads": agg["hot"],
        "warm_leads": agg["warm"],
        "pending_calls": agg["pending"],
        "not_answered": agg["not_answered"],
        "loan_interests": {
            "education": agg["education"],
            "business": agg["business"],
            "personal": agg["personal"],
        },
        "calling_hours": {
            "start": f"{CALL_START_HOUR}:00 IST",
            "end": f"{CALL_END_HOUR % 24 or 24}:00 IST",
            "currently_active": is_within_calling_hours(),
        },
    }

    # Breakdowns
    # Two GROUP BY queries instead of one COUNT per option. Every configured
    # option keeps a key (zero when absent), so the response shape is unchanged.
    by_status = {opt: 0 for opt in STATUS_OPTIONS}
    for r in await _state.db_pool.fetch(
        f"SELECT status, COUNT(*) AS n FROM agent_calls {where} GROUP BY status", *params
    ):
        if r["status"] in by_status:
            by_status[r["status"]] = r["n"]
    stats["by_status"] = by_status

    by_category = {opt: 0 for opt in CATEGORY_OPTIONS}
    for r in await _state.db_pool.fetch(
        f"SELECT category, COUNT(*) AS n FROM agent_calls {where} GROUP BY category", *params
    ):
        if r["category"] in by_category:
            by_category[r["category"]] = r["n"]
    stats["by_category"] = by_category

    return {"date": date or now_ist().strftime("%Y-%m-%d"), **stats}


@router.get("/funnel")
async def get_funnel(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    user: dict = Depends(get_current_bank_user),
):
    """Conversion funnel for the /ops/funnel dashboard.

    Stages (in order of progression):
        queued    — Pending or Scheduled
        attempted — anything past Pending (Calling or terminal)
        connected — completed call states (Called - …)
        interested — call_analysis.lead_quality in ('hot','warm')
        form_sent — form_sent = true
        application — has an application_id linked

    Defaults to today (IST) if no date range supplied.
    """
    where = "TRUE"
    params: list = []
    idx = 1

    bank_uuid = _bank_uuid(user)  # operator -> None (all banks); bank_user -> their bank
    if bank_uuid:
        where += f" AND bank_id = ${idx}"
        params.append(bank_uuid)
        idx += 1

    def _parse(d: str) -> Optional[datetime]:
        try:
            return _ist_midnight(d)
        except ValueError:
            return None

    if date_from:
        dt = _parse(date_from)
        if dt:
            where += f" AND created_at >= ${idx}"
            params.append(dt)
            idx += 1
    if date_to:
        dt = _parse(date_to)
        if dt:
            where += f" AND created_at < ${idx}"
            params.append(dt + timedelta(days=1))
            idx += 1

    if not date_from and not date_to:
        # Default: today (IST midnight)
        today = now_ist().replace(hour=0, minute=0, second=0, microsecond=0)
        where += f" AND created_at >= ${idx}"
        params.append(today)
        idx += 1

    base = f"SELECT COUNT(*) FROM agent_calls WHERE {where}"

    queued = await _state.db_pool.fetchval(
        f"{base} AND status IN ('Pending', 'Scheduled')", *params
    )
    attempted = await _state.db_pool.fetchval(
        f"{base} AND status NOT IN ('Pending', 'Scheduled')", *params
    )
    connected = await _state.db_pool.fetchval(
        f"{base} AND status LIKE 'Called%'", *params
    )
    interested = await _state.db_pool.fetchval(
        f"{base} AND call_analysis->>'lead_quality' IN ('hot', 'warm')", *params
    )
    form_sent = await _state.db_pool.fetchval(
        f"{base} AND form_sent = true", *params
    )
    application = await _state.db_pool.fetchval(
        f"{base} AND application_id IS NOT NULL", *params
    )
    total = queued + attempted

    return {
        "date_from": date_from,
        "date_to": date_to,
        "total": total,
        "stages": [
            {"key": "queued", "label": "Queued", "count": int(queued or 0)},
            {"key": "attempted", "label": "Attempted", "count": int(attempted or 0)},
            {"key": "connected", "label": "Connected", "count": int(connected or 0)},
            {"key": "interested", "label": "Interested", "count": int(interested or 0)},
            {"key": "form_sent", "label": "Form sent", "count": int(form_sent or 0)},
            {"key": "application", "label": "Application", "count": int(application or 0)},
        ],
    }


@router.get("/analytics")
async def get_analytics(user: dict = Depends(get_current_bank_user)):
    """Analytics summary (all calls)."""
    bank_uuid = _bank_uuid(user)  # operator -> None (all banks); bank_user -> their bank
    bank_clause = ""
    params: list = []
    if bank_uuid:
        bank_clause = " AND bank_id = $1"
        params.append(bank_uuid)
    base = f"SELECT COUNT(*) FROM agent_calls WHERE TRUE{bank_clause}"

    total = await _state.db_pool.fetchval(base, *params)
    forms_sent = await _state.db_pool.fetchval(f"{base} AND form_sent = true", *params)
    interested = await _state.db_pool.fetchval(f"{base} AND interested = true", *params)
    success_rate = await _state.db_pool.fetchval(
        f"{base} AND status IN ('Called', 'Completed', 'Called - Interested', 'Called - Not Interested')", *params)
    failure_rate = await _state.db_pool.fetchval(
        f"{base} AND status IN ('Failed', 'Not Answered', 'Call Not Connected')", *params)
    hot = await _state.db_pool.fetchval(f"{base} AND call_analysis->>'lead_quality' = 'hot'", *params)
    warm = await _state.db_pool.fetchval(f"{base} AND call_analysis->>'lead_quality' = 'warm'", *params)
    cold = await _state.db_pool.fetchval(f"{base} AND call_analysis->>'lead_quality' = 'cold'", *params)
    edu = await _state.db_pool.fetchval(f"{base} AND loan_type = 'education'", *params)
    biz = await _state.db_pool.fetchval(f"{base} AND loan_type = 'business'", *params)
    per = await _state.db_pool.fetchval(f"{base} AND loan_type = 'personal'", *params)

    return {
        "total_calls_made": total,
        "forms_sent": forms_sent,
        "interested_customers": interested,
        "success_rate": success_rate,
        "failure_rate": failure_rate,
        "lead_quality": {"hot": hot, "warm": warm, "cold": cold},
        "loan_types": {"education": edu, "business": biz, "personal": per},
    }


# ============================================================================
# EXPORT ENDPOINTS
# ============================================================================

# Spreadsheet formula-injection guard (SEC-08) — shared helper in lib/exportsafe.
from lib.exportsafe import harden_df as _harden_df  # noqa: E402


@router.get("/export/daily-report")
async def export_daily_report(
    request: Request,
    date: Optional[str] = None,
    user: dict = Depends(get_current_bank_user),
):
    """Export daily report as Excel."""
    # A full export of the bank's call records in one request - throttle
    # repeated pulls per user.
    _ratelimit.check("export", str(user.get("user_id") or "unknown"))
    bank_uuid = _bank_uuid(user)  # operator (admin) -> None (all banks); bank_user -> their bank
    await _audit.record_sensitive_access(
        _state.db_pool, request, actor=_audit.decode_actor(request), action="export_daily_report",
        entity_type="agent_calls", details={"date": date, "bank_id": (str(bank_uuid) if bank_uuid else None)})
    if not date:
        date = now_ist().strftime("%Y-%m-%d")
    try:
        dt = _ist_midnight(date)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format (YYYY-MM-DD)")

    rows = await _state.db_pool.fetch(
        """SELECT * FROM agent_calls
           WHERE created_at >= $1 AND created_at < $2
             AND ($3::uuid IS NULL OR bank_id = $3)
           ORDER BY created_at DESC""",
        dt, dt + timedelta(days=1), bank_uuid,
    )
    if not rows:
        raise HTTPException(status_code=404, detail="No data for this date")

    report_rows = []
    for r in rows:
        c = _row_to_dict(r)
        ca = c.get("call_analysis") or {}
        if isinstance(ca, str):
            try:
                ca = json.loads(ca)
            except (json.JSONDecodeError, ValueError) as e:
                logger.warning("call_analysis JSON parse failed for call %s: %s",
                               c.get("id", "?"), e)
                ca = {}
        report_rows.append({
            "Name": c.get("customer_name", ""),
            "Phone": c.get("phone", ""),
            "Status": c.get("status", ""),
            "Category": c.get("category", ""),
            "Lead Quality": ca.get("lead_quality", "") if isinstance(ca, dict) else "",
            "Duration (sec)": c.get("call_duration", "") or "",
            "Call Time": str(c.get("started_at", ""))[:19] if c.get("started_at") else "",
        })

    df = _harden_df(pd.DataFrame(report_rows))
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="Daily Report")
    output.seek(0)

    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename=agent_report_{date}.xlsx"},
    )


@router.get("/export/all-calls")
async def export_all_calls(
    request: Request,
    status: Optional[str] = None,
    category: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    lead_quality: Optional[str] = None,
    form_sent: Optional[str] = None,
    search: Optional[str] = None,
    user: dict = Depends(get_current_bank_user),
):
    """Comprehensive Excel export with all call data (bank-scoped for bank users).

    Accepts the SAME filters as GET /calls (status, category, date range,
    lead_quality, form_sent) so an export always matches the on-screen list
    (OPS-08). Previously lead_quality and form_sent were silently ignored, so an
    export taken under a Hot/Warm/Cold or Form-sent filter returned more rows
    than the screen showed.
    """
    # A full export of the bank's call records in one request - throttle
    # repeated pulls per user.
    _ratelimit.check("export", str(user.get("user_id") or "unknown"))
    conditions: list = []
    params: list = []
    idx = 1
    bank_uuid = _bank_uuid(user)  # operator (admin) -> None (all banks); bank_user -> their bank
    await _audit.record_sensitive_access(
        _state.db_pool, request, actor=_audit.decode_actor(request), action="export_all_calls",
        entity_type="agent_calls",
        details={"bank_id": (str(bank_uuid) if bank_uuid else None), "status": status,
                 "category": category, "date_from": date_from, "date_to": date_to,
                 "lead_quality": lead_quality, "form_sent": form_sent})
    if bank_uuid:
        conditions.append(f"bank_id = ${idx}")
        params.append(bank_uuid)
        idx += 1

    if status:
        # "Failed" is the umbrella for all hard-failure outcomes (Failed +
        # Invalid Phone + Call Not Connected), so counts/filters/exports match
        # the batch dashboards and Call Logs. Specific sub-statuses (e.g.
        # "Invalid Phone") still filter exactly when selected.
        if status == "Failed":
            conditions.append(f"status = ANY(${idx}::text[])")
            params.append(["Failed", "Invalid Phone", "Call Not Connected"])
        else:
            conditions.append(f"status = ${idx}")
            params.append(status)
        idx += 1
    if category:
        conditions.append(f"category = ${idx}")
        params.append(category)
        idx += 1
    # Mirror GET /calls exactly (OPS-08).
    if lead_quality:
        conditions.append(f"call_analysis->>'lead_quality' = ${idx}")
        params.append(lead_quality)
        idx += 1
    if form_sent in ("yes", "true"):
        conditions.append("form_sent = true")
    elif form_sent in ("no", "false"):
        conditions.append("form_sent = false")
    if search and search.strip():
        conditions.append(f"(customer_name ILIKE ${idx} OR phone ILIKE ${idx})")
        params.append(f"%{search.strip()}%")
        idx += 1
    if date_from:
        try:
            conditions.append(f"created_at >= ${idx}")
            params.append(_ist_midnight(date_from))
            idx += 1
        except ValueError:
            pass
    if date_to:
        try:
            conditions.append(f"created_at < ${idx}")
            params.append(_ist_midnight(date_to) + timedelta(days=1))
            idx += 1
        except ValueError:
            pass

    where = (" WHERE " + " AND ".join(conditions)) if conditions else ""
    rows = await _state.db_pool.fetch(
        f"SELECT * FROM agent_calls{where} ORDER BY created_at DESC",
        *params,
    )
    if not rows:
        raise HTTPException(status_code=404, detail="No data found")

    export_rows = []
    for r in rows:
        c = _row_to_dict(r)
        collected = c.get("collected_data") or {}
        if isinstance(collected, str):
            collected = json.loads(collected)
        analysis = c.get("call_analysis") or {}
        if isinstance(analysis, str):
            analysis = json.loads(analysis)

        export_rows.append({
            "Call ID": c.get("id", ""),
            "Name": c.get("customer_name", ""),
            "Phone": c.get("phone", ""),
            "Email": collected.get("email", ""),
            "Age": collected.get("age", ""),
            "Address": collected.get("collected_address", ""),
            "Aadhaar": collected.get("aadhar_number", ""),
            "PAN": collected.get("pan_number", ""),
            "Customer Type": collected.get("customer_type", ""),
            "Status": c.get("status", ""),
            "Category": c.get("category", ""),
            "Lead Quality": analysis.get("lead_quality", ""),
            "Interested": "Yes" if c.get("interested") else "No",
            "Loan Type": c.get("loan_type", ""),
            "Loan Amount": c.get("loan_amount", ""),
            "Loan Purpose": collected.get("loan_purpose", ""),
            "Employment": collected.get("employment_type", ""),
            "Employer": collected.get("employer_name", ""),
            "Designation": collected.get("designation", ""),
            "Monthly Income": collected.get("monthly_income", ""),
            "WhatsApp Form Sent": "Yes" if c.get("form_sent") else "No",
            "Form Submitted": "Yes" if collected.get("form_submitted") else "No",
            "Follow-up Needed": analysis.get("follow_up_needed", ""),
            "Reminder Date": analysis.get("reminder_date", ""),
            "Duration (sec)": c.get("call_duration", ""),
            "Retry Count": c.get("retry_count", 0),
            "Batch ID": c.get("batch_id", ""),
            "Call Start": str(c.get("started_at", ""))[:19] if c.get("started_at") else "",
            "Call End": str(c.get("ended_at", ""))[:19] if c.get("ended_at") else "",
            "Created At": str(c.get("created_at", ""))[:19] if c.get("created_at") else "",
        })

    df = _harden_df(pd.DataFrame(export_rows))
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="All Calls")
        ws = writer.sheets["All Calls"]
        for col_idx, col in enumerate(df.columns):
            try:
                col_max = int(df[col].astype(str).map(len).max() or 0)
            except Exception:
                col_max = 0
            max_len = max(col_max, len(str(col))) + 2
            letter = chr(65 + col_idx) if col_idx < 26 else chr(64 + col_idx // 26) + chr(65 + col_idx % 26)
            ws.column_dimensions[letter].width = min(max_len, 50)
    output.seek(0)

    fname = f"agent_calls_{now_ist().strftime('%Y%m%d_%H%M%S')}.xlsx"
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={fname}"},
    )


# ============================================================================
# STATUS ENDPOINTS
# ============================================================================

@router.get("/live-status")
async def get_live_status(user: dict = Depends(get_current_bank_user)):
    """Get current calling status -- which customer is being called right now."""
    bank_uuid = _bank_uuid(user)  # operator (admin) -> None (all banks); bank_user -> their bank
    # NULL = no filter (operator sees every bank). `IS NOT DISTINCT FROM` used
    # to be here and did the opposite: for an operator it matched only rows with
    # bank_id IS NULL, so /live-status showed them nothing but orphaned calls.
    row = await _state.db_pool.fetchrow(
        """SELECT id, customer_name, phone, started_at FROM agent_calls
           WHERE status = 'Calling' AND ($1::uuid IS NULL OR bank_id = $1) LIMIT 1""",
        bank_uuid,
    )

    if not row:
        return {
            "status": "idle",
            "message": "No active call",
            "current_call": None,
            "calling_hours_active": is_within_calling_hours(),
        }

    active = _row_to_dict(row)
    duration = None
    if active.get("started_at"):
        try:
            start = datetime.fromisoformat(active["started_at"])
            if start.tzinfo is None:
                start = start.replace(tzinfo=IST)
            duration = int((now_ist() - start).total_seconds())
        except Exception:
            pass

    return {
        "status": "active",
        "message": "Call in progress",
        "current_call": {
            "id": active["id"],
            "name": active.get("customer_name", ""),
            "phone": active.get("phone", ""),
            "duration_seconds": duration,
        },
        "calling_hours_active": is_within_calling_hours(),
    }


@router.post("/stale-cleanup")
async def stale_cleanup(user: dict = Depends(get_current_bank_user)):
    """Clean up calls stuck in 'Calling' status.

    Recovery action for /ops/batch. The body used to ignore bank scoping
    entirely while the dependency admits any bank officer, so one officer at one
    bank could hard-DELETE in-flight call rows and fail live calls for EVERY
    tenant — destructive and unrecoverable. Both statements are now scoped to
    the caller's bank; a platform operator (admin token) stays cross-bank, which
    is what the /ops console needs.
    """
    bank_uuid = _bank_uuid(user)  # operator (admin) -> None (all banks); bank_user -> their bank

    # 1. Delete broken calls (no room_name)
    if bank_uuid is None:
        del_result = await _state.db_pool.execute(
            """DELETE FROM agent_calls
               WHERE status = 'Calling'
                     AND (room_name IS NULL OR room_name = '')""",
        )
    else:
        del_result = await _state.db_pool.execute(
            """DELETE FROM agent_calls
               WHERE status = 'Calling'
                     AND (room_name IS NULL OR room_name = '')
                     AND bank_id = $1""",
            bank_uuid,
        )
    deleted = int(del_result.split()[-1]) if del_result else 0

    # 2. Fail old stuck calls (>10 min)
    ten_min_ago = now_ist() - timedelta(minutes=10)
    if bank_uuid is None:
        upd_result = await _state.db_pool.execute(
            """UPDATE agent_calls
               SET status = 'Failed', error_message = 'Manual cleanup - stuck call',
                   ended_at = $1, updated_at = $1
               WHERE status = 'Calling' AND started_at < $2""",
            now_ist(), ten_min_ago,
        )
    else:
        upd_result = await _state.db_pool.execute(
            """UPDATE agent_calls
               SET status = 'Failed', error_message = 'Manual cleanup - stuck call',
                   ended_at = $1, updated_at = $1
               WHERE status = 'Calling' AND started_at < $2 AND bank_id = $3""",
            now_ist(), ten_min_ago, bank_uuid,
        )
    cleaned = int(upd_result.split()[-1]) if upd_result else 0

    await release_batch_lock()

    return {
        "status": "success",
        "message": f"Deleted {deleted} broken, failed {cleaned} stuck calls.",
        "deleted": deleted,
        "failed_updated": cleaned,
    }
