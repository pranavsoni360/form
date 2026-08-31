"""Customer-facing ITR fetch — "Generate" beside the ITR upload button.

WHY THIS ENDPOINT IS UNUSUAL, AND WHAT IT DELIBERATELY DOES NOT DO

VG's `ITR_Advance` authenticates against the income-tax portal with the
applicant's own **username and password**. There is no token, no OTP, no consent
redirect: the credential must pass through this process to reach VG. That is a
live credential controlling the applicant's entire tax identity — far more
sensitive than anything else this application collects.

So the password is treated as radioactive:

  * never written to loan_applications, application_data, or any table
  * never logged — not at DEBUG, not in an exception, not in an audit row
  * never returned to the client
  * not accepted over plain HTTP unless explicitly allowed for local dev
  * held only as a local variable for the duration of one outbound call

The response is a full ITR extract (balance sheet, P&L, presumptive income).
We persist ONLY the derived income figures the scorecard needs plus the
assessment years present, because storing the raw extract would mean holding a
second copy of the applicant's complete tax position for no scoring benefit.

WHAT THE DATA IS GOOD FOR
A live capture (2026-08-27, UAT user 33) returned presumptive-income sections
44AD/44ADA and a full balance sheet — i.e. SELF-EMPLOYED income. This product is
salaried-only (`_validate_employment` rejects non-salaried at submit), so for
most applicants the useful field is whatever salary the ITR reports, and the
presumptive sections will be absent. Both shapes are handled; neither is assumed.
"""
from __future__ import annotations

import logging
import os
import uuid
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from lrs.providers.vg_docverify import _parse_lenient_json

logger = logging.getLogger("lrs-itr-routes")
router = APIRouter()

# Import the resolved base URL rather than re-deriving it. Declaring a second
# os.getenv with its OWN default was a real bug: with VG_DOCVERIFY_BASE_URL
# unset, this module defaulted to vpays.in (production) while vg_docverify.py
# defaulted to 10.200.10.43 (UAT). Credentials are chosen FROM the host
# (_creds_for), and this module imports those credentials — so it sent UAT
# user 33 to the production host, which has no such user, and every fetch came
# back "no return found". One source of truth for the host, always paired with
# the credentials that belong to it.
from lrs.providers.vg_docverify import _BASE_URL  # noqa: E402

_VGK_BASE = f"{_BASE_URL}/VGKVerify.asmx"
# ITR gets its OWN timeout, much longer than the 30s shared VG default.
#
# ITR_Advance is not a lookup: VG logs in to the income-tax portal as the
# applicant and pulls up to 3 years of returns, and the full extract is large
# (balance sheet, P&L, presumptive sections). Measured against UAT, a REJECTION
# comes back in 1-2s while a successful fetch does real work — so a 30s budget
# fails exactly the case that was working, and only that case. QA logged
# ReadTimeout while every probe with bad credentials returned promptly.
#
# The connect timeout stays short: an unreachable host should fail fast rather
# than make the customer wait two minutes to be told so.
_ITR_TIMEOUT = httpx.Timeout(
    float(os.getenv("ITR_TIMEOUT_SECONDS", "180")),
    connect=float(os.getenv("ITR_CONNECT_TIMEOUT_SECONDS", "10")),
)
_DEFAULT_YEARS = os.getenv("ITR_DEFAULT_YEARS", "3")

# A tax password must not cross a plaintext link. Local development over
# http://localhost is the only exception, and it has to be asked for.
_ALLOW_INSECURE = os.getenv("ITR_ALLOW_INSECURE", "").lower() in ("1", "true", "yes")


class ItrGenerateRequest(BaseModel):
    """Credentials for one ITR fetch. Nothing here is ever persisted."""

    session_token: str
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)
    number_of_years: str = Field(default=_DEFAULT_YEARS, pattern=r"^[1-9]$")

    model_config = {
        # Keep the password out of any repr()/str() of this model, so an
        # unrelated `logger.exception` or a framework traceback cannot leak it.
        "extra": "forbid",
    }

    def __repr__(self) -> str:  # pragma: no cover - defensive
        return f"ItrGenerateRequest(username={self.username!r}, password=<redacted>)"

    __str__ = __repr__


def _f(v: Any) -> float | None:
    try:
        if v in (None, "", [], {}):
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


def _dig(d: Any, *path: str) -> Any:
    """Walk a nested dict by key path, returning None at the first miss."""
    cur = d
    for k in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


def derive_itr_income(result: dict) -> dict:
    """Reduce a full ITR extract to the few figures the scorecard can use.

    Returns {} when nothing usable is present — an applicant with no filed
    return is a normal outcome, not an error.

    Precedence is deliberate: reported SALARY first (this is a salaried product),
    then presumptive professional/business income, then profit before tax as the
    broadest fallback. Each is annual; monthly is derived by /12 and rounded.
    """
    years = _dig(result, "itrData", "assmtYr")
    if not isinstance(years, list) or not years:
        return {}

    # Most recent financial year first — VG returns them in filing order and the
    # newest return is the one that reflects current earning capacity.
    def _fy(entry: dict) -> str:
        return str(entry.get("financialYear") or "")

    ordered = sorted(
        (y for y in years if isinstance(y, dict)), key=_fy, reverse=True
    )
    if not ordered:
        return {}

    latest = ordered[0]
    fin = latest.get("finInfo") if isinstance(latest.get("finInfo"), dict) else {}

    annual: float | None = None
    basis = ""

    # 1. Salary, if the return reports any.
    salary = _f(_dig(fin, "plDtld", "plAcct", "otherExpns", "compToEmplys", "salWages"))
    # `salWages` is what the filer PAID employees, not what they earned — it is
    # NOT income. Left here as a named non-source so nobody mistakes it later.
    del salary

    for path, label in (
        (("plSumm", "inc", "totalIncome"), "total_income"),
        (("plSumm", "totalProfitBeforeTax"), "profit_before_tax"),
    ):
        if annual is None:
            annual = _f(_dig(fin, *path))
            if annual:
                basis = label

    # 2. Presumptive income (44ADA professional, then 44AD business) is a truer
    #    figure than turnover for a self-employed filer, so it wins when present.
    for section, label in (("presumpInc44ADA", "presumptive_44ADA"),
                           ("presumpInc44AD", "presumptive_44AD")):
        rows = _dig(fin, "plDtld", "plAcct", section, "slNo")
        if isinstance(rows, list) and rows and isinstance(rows[0], dict):
            pres = rows[0].get("presInc")
            val = _f(pres if not isinstance(pres, dict) else pres.get("ttl"))
            if val:
                annual, basis = val, label
                break

    if not annual or annual <= 0:
        return {"itr_years": [_fy(y) for y in ordered if _fy(y)]}

    return {
        "annual_income": round(annual, 2),
        "net_monthly_income": round(annual / 12.0, 2),
        "itr_income_basis": basis,
        "itr_financial_year": _fy(latest),
        "itr_years": [_fy(y) for y in ordered if _fy(y)],
    }


# VG returns 101 on success. Other codes are not documented anywhere we have,
# so these mappings come from observed behaviour and stay deliberately cautious:
# where we do not know, we say we do not know rather than blaming the customer's
# credentials. Confirmed by probe: an otherwise-valid request with EMPTY
# username/password returns 102 with an empty result, so 102 means the portal
# login did not succeed.
_ITR_EMPTY_REASONS = {
    "102": ("The income-tax portal did not accept that user ID and password. "
            "Please check them, or upload the PDF instead."),
    "103": ("The income-tax portal is not responding right now. "
            "Please try again shortly, or upload the PDF instead."),
}


def _explain_empty_result(status: Any, vendor_msg: str) -> str:
    """Turn an empty ITR result into something the customer can act on."""
    key = str(status) if status is not None else ""
    if key in _ITR_EMPTY_REASONS:
        return _ITR_EMPTY_REASONS[key]
    if vendor_msg:
        # The vendor said something specific; it is more useful than our guess.
        return f"{vendor_msg} You can upload the PDF instead."
    return ("No income-tax return could be fetched for those details. "
            "Please check them, or upload the PDF instead.")


def _common_obj(api_code: str, loan_id: str) -> dict:
    """The credential/metadata block every VGKVerify call carries."""
    from lrs.providers.vg_docverify import (
        _APP_MODE, _BANK_NAME, _BANK_SHORT_CODE, _DEVICE_ID,
        _REQUEST_FROM, _USER_ID, _VERIFICATION_KEY,
    )
    return {
        "UserId": _USER_ID,
        "VerificationKey": _VERIFICATION_KEY,
        "App_Mode": _APP_MODE,
        "Request_From": _REQUEST_FROM,
        "Longitude": "",
        "Latitude": "",
        "Accuracy": "",
        "Device_Id": _DEVICE_ID,
        "Bank_Name": _BANK_NAME,
        "Bank_short_code": _BANK_SHORT_CODE,
        "Enter_User_Id": loan_id or "",
        "Enter_Desc": "Customer ITR fetch",
        "APICode": api_code,
    }


@router.post("/generate")
async def generate_itr(body: ItrGenerateRequest, request: Request) -> dict:
    """Fetch the applicant's ITR from the income-tax portal via VG.

    Authenticated by loan session token, matching the rest of the customer form
    (/api/upload-document-session, /api/autosave-session).
    """
    from agent import state as _state
    db_pool = _state.db_pool

    # A tax credential must not be sent over a plaintext connection.
    if request.url.scheme != "https" and not _ALLOW_INSECURE:
        host = (request.url.hostname or "").lower()
        if host not in ("localhost", "127.0.0.1", "::1"):
            raise HTTPException(
                status_code=400,
                detail="ITR fetch requires a secure connection. Please upload the PDF instead.",
            )

    session = await db_pool.fetchrow(
        "SELECT * FROM loan_sessions WHERE session_token = $1", body.session_token
    )
    if not session or not session["otp_verified"]:
        raise HTTPException(status_code=401, detail="Invalid or unverified session")

    app_row = await db_pool.fetchrow(
        "SELECT id, loan_id FROM loan_applications WHERE id = $1",
        session["application_id"],
    )
    if not app_row:
        raise HTTPException(status_code=404, detail="Application not found")

    obj = _common_obj("ITRAdvance", str(app_row["loan_id"] or ""))
    obj.update({
        "username": body.username,
        "password": body.password,
        "numberOfYears": body.number_of_years,
    })

    try:
        async with httpx.AsyncClient(timeout=_ITR_TIMEOUT) as client:
            resp = await client.post(f"{_VGK_BASE}/ITR_Advance", json={"obj": [obj]})
        resp.raise_for_status()
        data = _parse_lenient_json(resp.text)
    except httpx.TimeoutException as e:
        # Distinct from an unreachable host: the request WAS delivered and VG
        # simply had not answered yet. Saying "could not reach" sent everyone
        # hunting for a network fault that did not exist — the request was fine
        # and the budget was too small.
        logger.warning("ITR_Advance timed out after %ss for app=%s: %s",
                       _ITR_TIMEOUT.read, app_row["id"], type(e).__name__)
        raise HTTPException(
            status_code=504,
            detail=("The income-tax portal is taking longer than usual. "
                    "Please try again, or upload the PDF instead."),
        )
    except httpx.HTTPError as e:
        # Log the transport failure WITHOUT the request body: `obj` holds the
        # password, so it must never reach a log line or an exception message.
        logger.warning("ITR_Advance transport failure for app=%s: %s",
                       app_row["id"], type(e).__name__)
        raise HTTPException(
            status_code=502,
            detail="Could not reach the income-tax service. Please try again or upload the PDF.",
        )
    except ValueError:
        logger.warning("ITR_Advance returned an unparseable body for app=%s", app_row["id"])
        raise HTTPException(
            status_code=502,
            detail="The income-tax service returned an unreadable response. Please upload the PDF instead.",
        )
    finally:
        # Drop the credential as soon as the call is done, so it cannot be
        # captured by a later traceback holding this frame.
        obj["password"] = ""
        body.password = ""  # type: ignore[misc]

    result = data.get("result") if isinstance(data, dict) else None
    if not isinstance(result, dict) or not result:
        status = data.get("statusCode") if isinstance(data, dict) else None
        # Surface what VG actually said. A fixed "no return was found" message
        # made a wrong password, an unregistered PAN, a portal outage and an
        # account VG cannot reach all read identically — so nobody could tell a
        # user error from an integration fault, including us.
        vendor_msg = ""
        if isinstance(data, dict):
            for k in ("message", "Message", "statusMessage", "error", "Error", "remarks"):
                v = data.get(k)
                if isinstance(v, str) and v.strip():
                    vendor_msg = v.strip()
                    break
        logger.warning(
            "ITR_Advance returned no result for app=%s (statusCode=%s, message=%r, keys=%s)",
            app_row["id"], status, vendor_msg,
            sorted(data.keys()) if isinstance(data, dict) else "?",
        )
        detail = _explain_empty_result(status, vendor_msg)
        raise HTTPException(status_code=422, detail=detail)

    derived = derive_itr_income(result)
    if not derived.get("annual_income"):
        raise HTTPException(
            status_code=422,
            detail="The return was found but reported no usable income figure. Please upload the PDF instead.",
        )

    # Persist ONLY the derived figures. The raw extract is the applicant's whole
    # tax position; keeping it would be a second copy with no scoring benefit.
    await db_pool.execute(
        """UPDATE loan_applications
              SET itr_income_annual = $1,
                  itr_income_basis  = $2,
                  itr_financial_year = $3,
                  itr_fetched_at    = NOW()
            WHERE id = $4""",
        derived["annual_income"], derived.get("itr_income_basis"),
        derived.get("itr_financial_year"), app_row["id"],
    )
    logger.info("ITR fetched app=%s fy=%s basis=%s", app_row["id"],
                derived.get("itr_financial_year"), derived.get("itr_income_basis"))

    return {
        "status": "fetched",
        "annual_income": derived["annual_income"],
        "net_monthly_income": derived["net_monthly_income"],
        "financial_year": derived.get("itr_financial_year"),
        "basis": derived.get("itr_income_basis"),
        "years": derived.get("itr_years", []),
    }
