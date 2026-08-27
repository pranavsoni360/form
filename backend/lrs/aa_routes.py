"""Account Aggregator / Bank Statement Upload routes.

Mounted at /api/aa in main.py.

Flow:
  POST /api/aa/initiate/{application_id}
    Calls AcAggregator.asmx/Generateurl (destination=statementupload, last 6 months).
    Stores aa_request_id on the application and returns the upload URL for the officer
    to share with the customer.

  GET /api/aa/status/{application_id}
    Calls AcAggregator.asmx/statuscheck. When a successful txn is found, fetches the
    report via retrievereport, maps analysis_data.Overall → LRS input_keys, and
    stores the result in loan_applications.aa_lrs_inputs. The LRS rescore will then
    use that stored data via AcAggregatorBankStmtProvider (no extra API call).
"""
from __future__ import annotations

import datetime as _dt
import logging
import os
import uuid
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException

from agent.state import get_current_bank_user
from lrs.providers.vg_docverify import _parse_lenient_json

logger = logging.getLogger("lrs-aa-routes")
router = APIRouter()

_BASE_URL = os.getenv("VG_DOCVERIFY_BASE_URL", "https://vpays.in/VGDocverify").rstrip("/")
_AA_BASE = f"{_BASE_URL}/AcAggregator.asmx"
_CALLBACK_URL = os.getenv(
    "AA_CALLBACK_URL",
    "http://galaxypay.in:9002/VGDocverify/VGIL_TxnCallback.aspx",
)
_RETURN_URL = os.getenv("AA_RETURN_URL", "https://www.vgipl.com")
_TIMEOUT = float(os.getenv("VG_DOCVERIFY_TIMEOUT", "30"))


async def _aa_call(endpoint: str, obj: dict) -> dict:
    """POST to a VG AcAggregator endpoint and return the parsed response.

    VG appends {"d": null} after the JSON body — _parse_lenient_json handles that.
    """
    url = f"{_AA_BASE}/{endpoint}"
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.post(url, json={"obj": obj})
        resp.raise_for_status()
    return _parse_lenient_json(resp.text)


def _month_range_6() -> tuple[str, str]:
    """Return (start_month, end_month) as YYYY-MM strings covering the last 6 months."""
    today = _dt.date.today()
    y, m = today.year, today.month
    sm = m - 6
    sy = y
    if sm <= 0:
        sm += 12
        sy -= 1
    return f"{sy:04d}-{sm:02d}", f"{y:04d}-{m:02d}"


def _f(v: Any) -> float | None:
    try:
        return float(v) if v not in (None, "", []) else None
    except (TypeError, ValueError):
        return None


def _map_aa_report(report: dict, app_data: dict) -> dict[str, Any]:
    """Map analysis_data.Overall from the AA retrievereport response → LRS input_keys.

    Uses app_data (the loan_applications row) for form-collected NMI when the
    statement has no salary credits (e.g. self-employed customers).
    """
    out: dict[str, Any] = {}

    # Find first available account's Overall
    overall: dict | None = None
    for bank in (report.get("banks") or []):
        for account in (bank.get("accounts") or []):
            overall = (account.get("analysis_data") or {}).get("Overall")
            if overall:
                break
        if overall:
            break

    if not overall:
        logger.warning("AA map: no analysis_data.Overall found in report")
        return out

    # ── NMI from salary credits (salaried customers only) ────────────────────
    total_salary = _f(overall.get("Total Amount of Salary Credits"))
    period_days = report.get("statement_period_days") or 30
    months = max(period_days / 30.0, 1.0)

    nmi_from_aa: float | None = None
    if total_salary and total_salary > 0:
        nmi_from_aa = round(total_salary / months, 2)
        out["net_monthly_income"] = nmi_from_aa
        out["annual_income"] = round(nmi_from_aa * 12, 2)

    # NMI for ratio calculations: prefer AA-derived (salary-based), else form value
    try:
        nmi = (
            nmi_from_aa
            or _f(app_data.get("monthly_net_income"))
            or _f(app_data.get("monthly_gross_income"))
        )
    except (TypeError, ValueError):
        nmi = None

    # ── Average EOD Balance → amb_pct_of_nmi ─────────────────────────────────
    avg_eod = _f(overall.get("Average EOD Balance")) or _f(overall.get("Average Bank Balance"))
    if avg_eod is not None and nmi and nmi > 0:
        out["amb_pct_of_nmi"] = round(avg_eod / nmi * 100, 2)

    # ── Surplus Amount → net_cash_flow ────────────────────────────────────────
    surplus = _f(overall.get("Surplus Amount"))
    if surplus is not None:
        out["net_cash_flow"] = round(surplus, 2)

    # ── Average Surplus Amount → surplus_income_ratio (% of NMI) ─────────────
    avg_surplus = _f(overall.get("Average Surplus Amount"))
    if avg_surplus is not None and nmi and nmi > 0:
        out["surplus_income_ratio"] = round(avg_surplus / nmi * 100, 2)

    # ── Penalty charges ───────────────────────────────────────────────────────
    penalty = _f(overall.get("Total No. of Penalty Charges"))
    if penalty is not None:
        out["penalty_count"] = int(penalty)

    # ── EMI payments + bounces → otp_ratio_pct / missed_payment_ratio ────────
    emi_payments = _f(overall.get("No. of EMI / loan payments")) or _f(overall.get("Total No. of EMI / loan payments")) or 0.0
    emi_bounces = _f(overall.get("Total No. of EMI Bounces")) or 0.0
    if emi_payments > 0:
        missed = emi_bounces / emi_payments
        out["missed_payment_ratio"] = round(missed, 4)
        out["otp_ratio_pct"] = round((1.0 - missed) * 100, 2)

    # ── Employment type ───────────────────────────────────────────────────────
    emp_type = str(overall.get("Employment Type") or "").strip()
    if emp_type:
        _emp_map = {
            "self-employed": "self_employed_irregular",
            "salaried": "salaried_private_small",
        }
        out["employment_type"] = _emp_map.get(emp_type.lower(), "self_employed_irregular")

    return out


@router.post("/initiate/{application_id}")
async def initiate_aa(
    application_id: str,
    user: dict = Depends(get_current_bank_user),
) -> dict:
    """Generate a bank-statement upload URL and store the request_id on the application."""
    from agent import state as _state
    db_pool = _state.db_pool
    try:
        app_uuid = uuid.UUID(application_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid application_id")

    app_row = await db_pool.fetchrow(
        "SELECT id, bank_id FROM loan_applications WHERE id = $1", app_uuid
    )
    if not app_row:
        raise HTTPException(status_code=404, detail="application not found")
    if user.get("bank_id") and str(app_row["bank_id"]) != str(user["bank_id"]):
        raise HTTPException(status_code=403, detail="forbidden")

    start_month, end_month = _month_range_6()

    try:
        data = await _aa_call("Generateurl", {
            "txn_completed_cburl": _CALLBACK_URL,
            "start_month": start_month,
            "end_month": end_month,
            "destination": "statementupload",
            "return_url": _RETURN_URL,
            "acceptance_policy": "atLeastOneTransactionInRange",
            "relaxation_days": "0",
        })
    except httpx.HTTPError as e:
        logger.warning("AA Generateurl failed: %s", e)
        raise HTTPException(status_code=502, detail="Could not reach statement upload service")

    if data.get("status") != "success":
        raise HTTPException(status_code=502, detail=f"AA Generateurl returned non-success: {data}")

    request_id = str(data["request_id"])
    upload_url = data["url"]

    await db_pool.execute(
        "UPDATE loan_applications SET aa_request_id = $1, aa_initiated_at = NOW() WHERE id = $2",
        request_id, app_uuid,
    )
    logger.info("AA initiated app=%s request_id=%s", application_id, request_id)

    return {
        "url": upload_url,
        "expires": data.get("expires"),
        "request_id": request_id,
    }


@router.get("/status/{application_id}")
async def check_aa_status(
    application_id: str,
    user: dict = Depends(get_current_bank_user),
) -> dict:
    """Poll status. If complete, retrieve + map the report and store LRS inputs."""
    from agent import state as _state
    db_pool = _state.db_pool
    try:
        app_uuid = uuid.UUID(application_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid application_id")

    row = await db_pool.fetchrow(
        """SELECT id, bank_id, aa_request_id, aa_txn_id, aa_completed_at,
                  monthly_net_income, monthly_gross_income
             FROM loan_applications WHERE id = $1""",
        app_uuid,
    )
    if not row:
        raise HTTPException(status_code=404, detail="application not found")
    if user.get("bank_id") and str(row["bank_id"]) != str(user["bank_id"]):
        raise HTTPException(status_code=403, detail="forbidden")

    if not row["aa_request_id"]:
        return {"status": "not_initiated"}

    # Already processed — return stored result
    if row["aa_txn_id"] and row["aa_completed_at"]:
        return {"status": "complete", "txn_id": row["aa_txn_id"]}

    # Poll VG statuscheck
    try:
        status_data = await _aa_call("statuscheck", {"request_id": row["aa_request_id"]})
    except httpx.HTTPError as e:
        logger.warning("AA statuscheck failed: %s", e)
        raise HTTPException(status_code=502, detail="Could not reach statement service")

    txn_statuses = status_data.get("txn_status") or []
    success_txn = next((t for t in txn_statuses if t.get("status") == "Success"), None)

    if not success_txn:
        all_failed = bool(txn_statuses) and all(t.get("status") == "Failure" for t in txn_statuses)
        return {"status": "failed" if all_failed else "pending"}

    txn_id = success_txn["txn_id"]

    # Retrieve + map the report
    try:
        report = await _aa_call("retrievereport", {
            "txn_id": txn_id,
            "report_type": "json",
            "report_subtype": "type3",
        })
    except httpx.HTTPError as e:
        logger.warning("AA retrievereport failed txn=%s: %s", txn_id, e)
        raise HTTPException(status_code=502, detail="Could not retrieve bank statement report")

    app_data = {
        "monthly_net_income": row["monthly_net_income"],
        "monthly_gross_income": row["monthly_gross_income"],
    }
    mapped = _map_aa_report(report, app_data)
    logger.info("AA mapped fields for app=%s: %s", application_id, list(mapped.keys()))

    import json as _json
    await db_pool.execute(
        """UPDATE loan_applications
           SET aa_txn_id = $1, aa_completed_at = NOW(), aa_lrs_inputs = $2::jsonb
         WHERE id = $3""",
        txn_id, _json.dumps(mapped), app_uuid,
    )

    return {
        "status": "complete",
        "txn_id": txn_id,
        "mapped_fields": mapped,
    }
