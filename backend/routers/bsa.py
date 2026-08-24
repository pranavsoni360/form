"""
Bank Statement Analysis endpoints — officer-facing + the borrower callback.

Fronts services/acaggregator.py (the vendor client) with the journey state that
lives in migration_v42 `bsa_fetches`. See docs/ACAGGREGATOR_API_CAPTURES.md for
the captured vendor behaviour every decision here is based on.

THE THREE-CALL BUDGET
Digitap has no endpoint that takes a request and returns a report, so a journey
is always Generateurl -> statuscheck -> retrievereport. What we control is
POLLING: the borrower's callback tells us when to make calls 2 and 3, so the
normal path makes exactly three. `sweep_stale` is the fallback for journeys where
no callback ever arrives, and it is bounded, not a loop.

WHY A CALLBACK CANNOT BE TRUSTED
Its contract is unconfirmed — no known signature, no documented body. So the
callback is only ever a HINT: we log it and then verify with statuscheck. That
also means the endpoint is unauthenticated by necessity, which is why it reveals
nothing and always returns 200 (a non-200 risks a retry storm from a vendor whose
retry behaviour we have not observed).
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from services import acaggregator as ac

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bsa", tags=["bank-statement-analysis"])


def _main():
    import sys
    return sys.modules["__main__"] if "__main__" in sys.modules else sys.modules["main"]


def _db():
    pool = getattr(_main(), "db_pool", None)
    if pool is None:
        raise HTTPException(503, "database pool not ready")
    return pool


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── config ───────────────────────────────────────────────────────────────────

async def _config_for(bank_id: Optional[str]) -> dict:
    """
    Per-bank vendor config, falling back to the platform default row.

    Kept in the database rather than env so that going live is a config change:
    everything currently points at Digitap's SANDBOX.
    """
    row = None
    if bank_id:
        row = await _db().fetchrow(
            "SELECT * FROM bsa_tenant_config WHERE bank_id = $1 AND is_active",
            uuid.UUID(bank_id),
        )
    if not row:
        row = await _db().fetchrow(
            "SELECT * FROM bsa_tenant_config WHERE bank_id IS NULL AND is_active"
        )
    if not row:
        raise HTTPException(503, "Bank statement analysis is not configured.")
    return dict(row)


def _client(cfg: dict) -> ac.AcAggregatorClient:
    return ac.AcAggregatorClient(cfg["base_url"], cfg.get("api_key"))


# ── models ───────────────────────────────────────────────────────────────────

class StartFetch(BaseModel):
    application_id: str
    # Which bank issued the statement. Digitap template-matches the PDF against
    # this, so a mismatch fails inside THEIR ui (error 065) and never reaches us.
    institution_id: int
    institution_name: Optional[str] = None
    # Statement window. Defaults come from config; the officer sets the credit
    # policy, not the borrower.
    months: Optional[int] = None


# ── institutions ─────────────────────────────────────────────────────────────

@router.get("/institutions")
async def list_institutions(refresh: bool = False):
    """
    Banks a borrower can pick, newest cache first.

    Cached deliberately: this is reference data (90 rows), and fetching it per
    application would push every journey to four vendor calls instead of three.

    Sandbox entities (ACME Bank, Setu FIP, GPay…) and banks defunct since the
    2019 amalgamation (Allahabad, Dena, Syndicate…) are marked not-selectable
    rather than deleted — a borrower must not be able to pick one, but an old
    row may still need interpreting.
    """
    cached = await _db().fetch(
        "SELECT digitap_id, name, inst_type, form26as_enabled FROM bsa_institutions "
        "WHERE list_type = 'Statement' AND is_selectable ORDER BY name"
    )
    if cached and not refresh:
        return {"institutions": [dict(r) for r in cached], "cached": True}

    cfg = await _config_for(None)
    try:
        rows = await _client(cfg).institution_list("Statement")
    except (ac.AcAggregatorError, ac.AcAggregatorTransportError) as e:
        if cached:
            # Serve a stale list rather than blocking the borrower on a vendor
            # outage; the data barely changes.
            logger.warning("BSA: institution refresh failed, serving cache: %s", e)
            return {"institutions": [dict(r) for r in cached], "cached": True, "stale": True}
        raise HTTPException(502, f"Could not load the bank list: {e}")

    _SANDBOX = {"acme", "finshare", "finvu", "setu", "gpay", "pinelabs", "millennium"}
    _DEFUNCT = {"allahabad", "andhra bank", "corporation bank", "dena", "oriental bank",
                "syndicate", "united bank", "vijaya"}

    async with _db().acquire() as conn:
        async with conn.transaction():
            for i in rows:
                low = i.name.lower()
                reason = None
                if any(s in low for s in _SANDBOX):
                    reason = "sandbox"
                elif any(d in low for d in _DEFUNCT):
                    reason = "defunct_2019_amalgamation"
                await conn.execute(
                    "INSERT INTO bsa_institutions "
                    "(digitap_id, list_type, name, inst_type, form26as_enabled, username_regex, "
                    " is_selectable, excluded_reason, fetched_at) "
                    "VALUES ($1,'Statement',$2,$3,$4,$5,$6,$7,NOW()) "
                    "ON CONFLICT (digitap_id, list_type) DO UPDATE SET "
                    "  name = EXCLUDED.name, inst_type = EXCLUDED.inst_type, "
                    "  form26as_enabled = EXCLUDED.form26as_enabled, "
                    "  is_selectable = EXCLUDED.is_selectable, "
                    "  excluded_reason = EXCLUDED.excluded_reason, fetched_at = NOW()",
                    i.digitap_id, i.name, i.inst_type, i.form26as_enabled,
                    i.username_regex, reason is None, reason,
                )
    fresh = await _db().fetch(
        "SELECT digitap_id, name, inst_type, form26as_enabled FROM bsa_institutions "
        "WHERE list_type = 'Statement' AND is_selectable ORDER BY name"
    )
    return {"institutions": [dict(r) for r in fresh], "cached": False}


# ── start a journey (vendor call 1 of 3) ─────────────────────────────────────

@router.post("/fetches")
async def start_fetch(body: StartFetch, request: Request):
    """Issue a borrower upload link and record the journey."""
    app_row = await _db().fetchrow(
        "SELECT id, bank_id, loan_id FROM loan_applications WHERE id = $1",
        uuid.UUID(body.application_id),
    )
    if not app_row:
        raise HTTPException(404, "Application not found.")
    bank_id = str(app_row["bank_id"]) if app_row["bank_id"] else None
    cfg = await _config_for(bank_id)

    months = body.months or cfg["default_months"]
    end = _now()
    start = end - timedelta(days=31 * months)
    start_month, end_month = start.strftime("%Y-%m"), end.strftime("%Y-%m")

    callback_url = cfg.get("callback_url") or str(request.url_for("bsa_callback"))

    try:
        link = await _client(cfg).generate_upload_url(
            institution_id=body.institution_id,
            start_month=start_month,
            end_month=end_month,
            callback_url=callback_url,
            return_url=cfg["return_url"],
            acceptance_policy=cfg["default_acceptance_policy"],
        )
    except ac.AcAggregatorError as e:
        # InvalidInstitution is the common one: an id Digitap does not support,
        # or a comma-separated list (rejected despite the documented regex).
        raise HTTPException(400, f"{e.code}: {e.message}")
    except ac.AcAggregatorTransportError as e:
        raise HTTPException(502, str(e))

    row = await _db().fetchrow(
        "INSERT INTO bsa_fetches (application_id, bank_id, destination, institution_id, "
        " institution_name, start_month, end_month, request_id, upload_url, expires_at, "
        " status, next_check_at) "
        "VALUES ($1,$2,'statementupload',$3,$4,$5,$6,$7,$8,$9,'pending',$10) RETURNING *",
        uuid.UUID(body.application_id), uuid.UUID(bank_id) if bank_id else None,
        body.institution_id, body.institution_name, start_month, end_month,
        link.request_id, link.url, link.expires_at,
        # The fallback sweep runs just after the link dies, not on a timer: a
        # journey that produced no callback is only definitively over once the
        # link can no longer be used.
        (link.expires_at or _now() + timedelta(hours=24)) + timedelta(minutes=5),
    )
    return {"fetch": _public(dict(row))}


# ── the borrower finished (hint only) ────────────────────────────────────────

@router.post("/callback", name="bsa_callback")
async def bsa_callback(request: Request):
    """
    Digitap calls this when a borrower completes a journey.

    Deliberately permissive and deliberately uninformative. The contract is
    unconfirmed — body shape, headers and whether it is signed are all unknown —
    so this endpoint trusts nothing: it logs the raw payload, marks the journey
    for immediate verification, and lets `advance` do the real work via
    statuscheck. Always 200, because a non-200 could trigger retries from a
    vendor whose retry behaviour we have not observed.
    """
    raw: Any
    try:
        raw = await request.json()
    except Exception:
        try:
            raw = dict(await request.form())
        except Exception:
            raw = {"_body": (await request.body()).decode("utf-8", "replace")[:4000]}

    # The identifying field could be named anything; try the plausible ones and
    # fall back to a scan rather than guessing one shape.
    req_id = None
    if isinstance(raw, dict):
        for k in ("request_id", "requestId", "req_id", "reqId"):
            if raw.get(k):
                req_id = str(raw[k])
                break

    logger.info("BSA callback received (request_id=%s): %s", req_id, str(raw)[:500])

    if req_id:
        await _db().execute(
            "UPDATE bsa_fetches SET callback_raw = $1::jsonb, callback_at = NOW(), "
            " next_check_at = NOW(), updated_at = NOW() "
            "WHERE request_id = $2 AND status IN ('pending','processing')",
            __import__("json").dumps(raw), req_id,
        )
    return {"received": True}


# ── advance a journey (vendor calls 2 and 3) ─────────────────────────────────

@router.post("/fetches/{fetch_id}/advance")
async def advance(fetch_id: str):
    """
    Move one journey forward: statuscheck, then retrievereport if ready.

    Called by the callback path and by the stale sweep. Safe to call repeatedly —
    a completed row short-circuits.
    """
    row = await _db().fetchrow("SELECT * FROM bsa_fetches WHERE id = $1", uuid.UUID(fetch_id))
    if not row:
        raise HTTPException(404, "Fetch not found.")
    return {"fetch": _public(await _advance_row(dict(row)))}


async def _advance_row(f: dict) -> dict:
    if f["status"] in ("completed", "failed", "expired"):
        return f

    cfg = await _config_for(str(f["bank_id"]) if f["bank_id"] else None)
    client = _client(cfg)

    try:
        st = await client.status_check(f["request_id"])
    except ac.AcAggregatorTransportError as e:
        # Transient: leave the row alone so the next trigger retries.
        logger.warning("BSA statuscheck transport error for %s: %s", f["id"], e)
        return f

    expired = bool(f["expires_at"] and _now() > f["expires_at"])

    # TxnNotFound with no attempts means the borrower has not engaged at all.
    # That is PENDING while the link lives — Digitap creates no transaction until
    # the URL is opened — and only failure once it cannot be used.
    if st.not_found:
        if expired:
            return await _finish(f, "expired", "TxnNotFound",
                                 "The upload link expired before the borrower used it.")
        return f

    txn_id = st.successful_txn_id
    if txn_id:
        try:
            report = await client.retrieve_report(txn_id)
        except ac.AcAggregatorError as e:
            if e.code == "TxnNotCompleted":
                # Report not built yet; stay processing.
                return await _mark(f, "processing", e.code, e.message, st.raw, txn_id)
            return await _finish(f, "failed", e.code, e.message, st.raw, txn_id)
        except ac.AcAggregatorTransportError as e:
            logger.warning("BSA retrievereport transport error for %s: %s", f["id"], e)
            return f
        return await _store_report(f, txn_id, report, st.raw)

    if st.all_failed:
        last = st.attempts[-1]
        return await _finish(f, "failed", last.code, last.msg, st.raw, last.txn_id)

    # Attempts exist but none is terminal — or carry a status we have never seen.
    # Unrecognised means still-working: failing a live application on an unknown
    # string would be the worse error.
    return await _mark(f, "processing", None, None, st.raw,
                       st.attempts[-1].txn_id if st.attempts else None)


async def _mark(f, status, code, msg, txn_raw, txn_id):
    import json as _json
    row = await _db().fetchrow(
        "UPDATE bsa_fetches SET status = $2, vendor_code = $3, vendor_message = $4, "
        " txn_status_raw = $5::jsonb, txn_id = COALESCE($6, txn_id), "
        " check_count = check_count + 1, updated_at = NOW() WHERE id = $1 RETURNING *",
        f["id"], status, code, msg, _json.dumps(txn_raw) if txn_raw else None, txn_id,
    )
    return dict(row)


async def _finish(f, status, code, msg, txn_raw=None, txn_id=None):
    import json as _json
    row = await _db().fetchrow(
        "UPDATE bsa_fetches SET status = $2, vendor_code = $3, vendor_message = $4, "
        " txn_status_raw = COALESCE($5::jsonb, txn_status_raw), txn_id = COALESCE($6, txn_id), "
        " completed_at = NOW(), next_check_at = NULL, check_count = check_count + 1, "
        " updated_at = NOW() WHERE id = $1 RETURNING *",
        f["id"], status, code, msg, _json.dumps(txn_raw) if txn_raw else None, txn_id,
    )
    return dict(row)


async def _store_report(f, txn_id, report, txn_raw):
    import json as _json
    from services import bsa_metrics
    metrics = bsa_metrics.derive(report)
    row = await _db().fetchrow(
        "UPDATE bsa_fetches SET status = 'completed', vendor_code = 'ReportGenerated', "
        " txn_id = $2, txn_status_raw = $3::jsonb, report_raw = $4::jsonb, metrics = $5::jsonb, "
        " completed_at = NOW(), next_check_at = NULL, check_count = check_count + 1, "
        " updated_at = NOW() WHERE id = $1 RETURNING *",
        f["id"], txn_id, _json.dumps(txn_raw) if txn_raw else None,
        _json.dumps(report), _json.dumps(metrics),
    )
    return dict(row)


# ── read ─────────────────────────────────────────────────────────────────────

@router.get("/applications/{application_id}/fetches")
async def list_for_application(application_id: str):
    rows = await _db().fetch(
        "SELECT * FROM bsa_fetches WHERE application_id = $1 ORDER BY created_at DESC",
        uuid.UUID(application_id),
    )
    return {"fetches": [_public(dict(r)) for r in rows]}


def _public(f: dict) -> dict:
    """
    Strip the journey down to what a UI may see.

    `report_raw` is deliberately excluded: it carries unmasked name, email,
    phone, PAN, address, DOB and every transaction narration, plus a presigned S3
    URL to the raw file. `metrics` is the small derived summary and is safe.
    """
    return {
        "id": str(f["id"]),
        "application_id": str(f["application_id"]),
        "status": f["status"],
        "institution_id": f.get("institution_id"),
        "institution_name": f.get("institution_name"),
        "start_month": f.get("start_month"),
        "end_month": f.get("end_month"),
        "upload_url": f.get("upload_url"),
        "expires_at": f["expires_at"].isoformat() if f.get("expires_at") else None,
        "vendor_code": f.get("vendor_code"),
        "vendor_message": f.get("vendor_message"),
        "metrics": f.get("metrics"),
        "has_report": bool(f.get("report_raw")),
        "created_at": f["created_at"].isoformat() if f.get("created_at") else None,
        "completed_at": f["completed_at"].isoformat() if f.get("completed_at") else None,
    }


# ── fallback sweep ───────────────────────────────────────────────────────────

async def sweep_stale(limit: int = 50) -> int:
    """
    Advance journeys whose callback never arrived.

    Required, not belt-and-braces: a borrower who uploads a statement from the
    wrong bank gets error 065 inside DIGITAP'S OWN UI. No callback fires and
    statuscheck keeps returning TxnNotFound, so without a time-based sweep those
    applications sit pending forever.

    Bounded by `limit` and driven by next_check_at, so it is not a polling loop.
    """
    rows = await _db().fetch(
        "SELECT * FROM bsa_fetches WHERE status IN ('pending','processing') "
        "AND next_check_at IS NOT NULL AND next_check_at <= NOW() "
        "ORDER BY next_check_at LIMIT $1",
        limit,
    )
    advanced = 0
    for r in rows:
        try:
            await _advance_row(dict(r))
            advanced += 1
        except Exception:
            logger.exception("BSA sweep failed for fetch %s", r["id"])
    return advanced
