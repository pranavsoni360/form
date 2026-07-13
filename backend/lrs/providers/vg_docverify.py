"""Real data-fetch adapters backed by the VG Document Verification API
(Protean Credit Verification Services).

These are the "Phase C" live adapters referenced in providers/__init__.py and
mock.py. They implement the SAME `Provider` contract as the mock fixtures, so
the engine and orchestration are untouched — only the data source changes.

Coverage vs the LRS scorecard pillars (see config/scorecard.json):
  - Experian Report      -> credit_bureau pillar   (ExperianBureauProvider)
  - ITR Advance          -> income pillar           (ITRIncomeProvider)  [partial]
  - PAN + DigiLocker      -> personal_profile pillar (PanKycProvider)
The banking_behaviour pillar has NO live endpoint in this vendor set yet, so it
stays on the mock provider (see get_providers() in __init__.py).

Contract reminder (base.Provider): fetch() must return {} for a merely-absent
applicant so the engine re-weights around the missing pillar, and raise only on
genuine transient errors (network / 5xx) so the job worker retries.

IMPORTANT: the exact response JSON for each endpoint was NOT supplied by the
vendor yet. Every response field is read defensively via `_dig()` against the
most-likely key names, and any key we cannot find is simply omitted (that
parameter then scores as "absent" and is re-weighted). Confirm the field paths
against the vendor's real sample response and adjust the `*_FIELDS` maps below —
that is the ONLY place that needs to change once samples arrive (marked TODO).
"""
from __future__ import annotations

import datetime as _dt
import logging
import os
from typing import Any

import httpx

from lrs.providers.base import FetchContext

logger = logging.getLogger("lrs-vg-docverify")

# ── Configuration (env-first; documented defaults from VG_Docverify_API doc) ──
# SECURITY: these are the bank's shared credentials from the API doc. Prefer
# setting them via environment / secrets manager before deploying; the defaults
# exist only so the integration is functional out of the box in the VG env.
_BASE_URL = os.getenv("VG_DOCVERIFY_BASE_URL", "http://10.200.10.43/VGDocverify").rstrip("/")
_USER_ID = os.getenv("VG_DOCVERIFY_USER_ID", "3")
_VERIFICATION_KEY = os.getenv("VG_DOCVERIFY_VERIFICATION_KEY", "CONV27032026")
_BANK_NAME = os.getenv("VG_DOCVERIFY_BANK_NAME", "VIRTUAL URBAN CO-OPERATIVE BANK LTD.")
_BANK_SHORT_CODE = os.getenv("VG_DOCVERIFY_BANK_SHORT_CODE", "VGIPL")
_APP_MODE = os.getenv("VG_DOCVERIFY_APP_MODE", "LRS")
_REQUEST_FROM = os.getenv("VG_DOCVERIFY_REQUEST_FROM", "LRS")
_DEVICE_ID = os.getenv("VG_DOCVERIFY_DEVICE_ID", "lrs-backend")
_TIMEOUT = float(os.getenv("VG_DOCVERIFY_TIMEOUT", "30"))

# The two .asmx services these endpoints live on (from the API doc).
_PROTEAN = f"{_BASE_URL}/ProteanCredit.asmx"
_VGK = f"{_BASE_URL}/VGKVerify.asmx"


def is_configured() -> bool:
    """True when a VG Docverify base URL is configured (real mode available)."""
    return bool(os.getenv("VG_DOCVERIFY_BASE_URL"))


# ── Shared HTTP client ────────────────────────────────────────────────────────

def _common_params(api_code: str, ctx: FetchContext) -> dict[str, Any]:
    """The common credential/metadata block shared by every request (see doc §2)."""
    geo = (ctx.app or {}).get("geolocation") or {}
    return {
        "UserId": _USER_ID,
        "VerificationKey": _VERIFICATION_KEY,
        "App_Mode": _APP_MODE,
        "Request_From": _REQUEST_FROM,
        "Longitude": str(geo.get("longitude", "")),
        "Latitude": str(geo.get("latitude", "")),
        "Accuracy": str(geo.get("accuracy", "")),
        "Device_Id": _DEVICE_ID,
        "Bank_Name": _BANK_NAME,
        "Bank_short_code": _BANK_SHORT_CODE,
        "Enter_User_Id": str((ctx.app or {}).get("loan_id", "")),
        "Enter_Desc": "LRS auto-scoring",
        "APICode": api_code,
    }


async def _post(url: str, api_code: str, ctx: FetchContext, fields: dict) -> dict | None:
    """POST one `obj`-wrapped request and return the parsed `result` payload.

    Returns None when the applicant simply has no record (so the caller returns
    {} and the pillar is re-weighted). Raises on network / HTTP 5xx so the job
    worker retries.
    """
    body = {"obj": [{**_common_params(api_code, ctx), **fields}]}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(url, json=body)
        resp.raise_for_status()
        data = resp.json()
    except (httpx.HTTPError, ValueError) as e:
        # Network error / 5xx / bad JSON → transient: let the worker retry.
        logger.warning("VG Docverify %s call failed: %s", api_code, e)
        raise
    # Envelope: {"requestId": ..., "result": {...|[...]}, "statusCode": 101}
    result = data.get("result") if isinstance(data, dict) else None
    if not result:
        logger.info("VG Docverify %s returned no result (statusCode=%s)",
                    api_code, data.get("statusCode") if isinstance(data, dict) else "?")
        return None
    return result if isinstance(result, dict) else {"_list": result}


# ── Small safe extractors ─────────────────────────────────────────────────────

def _dig(d: dict, *keys: str) -> Any:
    """Return the first present, non-empty value among `keys` (case-insensitive)."""
    if not isinstance(d, dict):
        return None
    lower = {str(k).lower(): v for k, v in d.items()}
    for k in keys:
        v = lower.get(k.lower())
        if v not in (None, "", []):
            return v
    return None


def _num(v: Any) -> float | None:
    try:
        return float(str(v).replace(",", "").strip()) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _split_name(full: str | None) -> tuple[str, str]:
    parts = (full or "").strip().split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], " ".join(parts[1:])


def _fmt_date(v: Any) -> str:
    """Format a DB date/datetime (or string) for the API. TODO: confirm the
    vendor's expected date format (assumed dd/mm/yyyy here)."""
    if isinstance(v, (_dt.date, _dt.datetime)):
        return v.strftime("%d/%m/%Y")
    return str(v or "")


def _age_from_dob(v: Any) -> int | None:
    dob = None
    if isinstance(v, _dt.datetime):
        dob = v.date()
    elif isinstance(v, _dt.date):
        dob = v
    else:
        for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
            try:
                dob = _dt.datetime.strptime(str(v), fmt).date()
                break
            except (ValueError, TypeError):
                continue
    if dob is None:
        return None
    today = _dt.date.today()
    return today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))


# ── Endpoint client (all 2.5 APIs' endpoint URLs live here) ───────────────────

class VGDocverifyClient:
    """Thin async client exposing every VG Docverify endpoint from the doc.

    Scoring uses the synchronous single-call endpoints (experian_report,
    pan, pan_authentication, itr_advance). The DigiLocker methods are provided
    for completeness — that flow needs a user-consent round-trip and is wired
    separately from the scoring path (it must not block scoring), so it is not
    invoked during automatic scoring.
    """

    async def experian_report(self, ctx: FetchContext) -> dict | None:
        first, last = _split_name((ctx.app or {}).get("customer_name"))
        return await _post(f"{_PROTEAN}/experianreport", "ExperianReport", ctx, {
            "phoneNumber": ctx.phone or "",
            "pan": ctx.pan or "",
            "firstName": first,
            "lastName": last,
            "dateOfBirth": _fmt_date((ctx.app or {}).get("date_of_birth")),
            "pincode": str((ctx.app or {}).get("pincode", "")),
        })

    async def pan(self, ctx: FetchContext) -> dict | None:
        return await _post(f"{_VGK}/Pan", "pancard", ctx, {"PanNo": ctx.pan or ""})

    async def pan_authentication(self, ctx: FetchContext) -> dict | None:
        return await _post(f"{_VGK}/PanAuthentication", "pan-authentication", ctx, {
            "PanNo": ctx.pan or "",
            "Name": (ctx.app or {}).get("customer_name", ""),
            "Date_of_Birth": _fmt_date((ctx.app or {}).get("date_of_birth")),
        })

    async def itr_advance(self, ctx: FetchContext, *, username: str,
                          password: str, number_of_years: str = "3") -> dict | None:
        return await _post(f"{_VGK}/ITR_Advance", "ITRAdvance", ctx, {
            "username": username,
            "password": password,
            "numberOfYears": number_of_years,
        })

    # DigiLocker 3-step flow (needs user consent between step 1 and 2).
    async def digilocker_link(self, ctx: FetchContext, *, redirect_url: str,
                              o_auth_state: str = "123",
                              custom_doc_list: str = "ADHAR") -> dict | None:
        return await _post(f"{_VGK}/Digilockerlink", "digilocker_link", ctx, {
            "redirectUrl": redirect_url,
            "oAuthState": o_auth_state,
            "aadhaarFlowRequired": "true",
            "pinlessAuth": "true",
            "customDocList": custom_doc_list,
        })

    async def digilocker_documents(self, ctx: FetchContext, *, access_request_id: str) -> dict | None:
        return await _post(f"{_VGK}/Digilockerdocuments", "digilocker_doc", ctx, {
            "AccessRequestId": access_request_id,
        })

    async def digilocker_download(self, ctx: FetchContext, *, access_request_id: str,
                                  uri: str) -> dict | None:
        return await _post(f"{_VGK}/Digilockerdownload", "digilocker_download", ctx, {
            "AccessRequestId": access_request_id,
            "uri": uri,
            "pdfB64": "true", "parsed": "true", "xml": "true", "json": "true",
        })


_client = VGDocverifyClient()


# ── Providers (mirror the mock provider names/pillars 1:1) ────────────────────

class ExperianBureauProvider:
    """Credit-bureau pillar, backed by the Experian Report endpoint.

    TODO: the response field paths below are best-guess names — replace with the
    real ones from the vendor's sample response. Keys we can't find are omitted
    (that parameter scores as absent and the pillar re-weights)."""
    name = "bureau"
    pillar = "credit_bureau"

    async def fetch(self, ctx: FetchContext) -> dict[str, Any]:
        if not ctx.pan and not ctx.phone:
            return {}
        result = await _client.experian_report(ctx)
        if not result:
            return {}
        out: dict[str, Any] = {}
        # credit_bureau pillar input_keys (see scorecard.json)
        _set(out, "credit_score", _num(_dig(result, "credit_score", "creditScore", "score", "bureauScore")))
        _set(out, "on_time_payment_pct", _num(_dig(result, "on_time_payment_pct", "onTimePaymentPct", "paymentHistoryPct")))
        _set(out, "credit_utilization_pct", _num(_dig(result, "credit_utilization_pct", "creditUtilizationPct", "utilizationPct")))
        _set(out, "hard_inquiries_12m", _num(_dig(result, "hard_inquiries_12m", "enquiriesLast12Months", "enquiryCount")))
        _set(out, "credit_history_years", _num(_dig(result, "credit_history_years", "creditHistoryYears", "oldestAccountYears")))
        # existing-liabilities keys (used by personal_profile + normalize)
        _set(out, "active_loans_count", _num(_dig(result, "active_loans_count", "activeAccounts", "openAccounts")))
        _set(out, "cc_utilization_pct", _num(_dig(result, "cc_utilization_pct", "ccUtilizationPct")))
        _set(out, "total_existing_emi", _num(_dig(result, "total_existing_emi", "totalEmi", "totalEMIAmount")))
        # public records: map negative flags → scorecard category (default "none")
        out["public_record_type"] = _public_record_type(result)
        return out


class ITRIncomeProvider:
    """Income pillar, backed by ITR Advance. PARTIAL: the endpoint needs the
    applicant's ITR-portal username/password, which the form does not capture —
    so unless VG_DOCVERIFY_ITR_USERNAME/PASSWORD are configured, this returns {}
    and the income pillar falls back to form-derived income + re-weighting."""
    name = "income"
    pillar = "income"

    async def fetch(self, ctx: FetchContext) -> dict[str, Any]:
        username = os.getenv("VG_DOCVERIFY_ITR_USERNAME") or (ctx.app or {}).get("itr_username")
        password = os.getenv("VG_DOCVERIFY_ITR_PASSWORD") or (ctx.app or {}).get("itr_password")
        if not username or not password:
            return {}
        result = await _client.itr_advance(ctx, username=username, password=password)
        if not result:
            return {}
        out: dict[str, Any] = {}
        annual = _num(_dig(result, "annual_income", "annualIncome", "grossSalary", "grossTotalIncome"))
        if annual:
            _set(out, "annual_income", annual)
            _set(out, "net_monthly_income", round(annual / 12.0, 2))
        return out


class PanKycProvider:
    """Profile & Identity pillar, backed by PAN Authentication (name/DOB match).

    Provides `age_years` (derived from the authenticated DOB) and records PAN
    validity. Aadhaar/DigiLocker attributes (address/ownership) require the
    consent flow and are not fetched during scoring."""
    name = "kyc"
    pillar = "personal_profile"

    async def fetch(self, ctx: FetchContext) -> dict[str, Any]:
        if not ctx.pan:
            return {}
        result = await _client.pan_authentication(ctx)
        if not result:
            return {}
        out: dict[str, Any] = {}
        dob = _dig(result, "date_of_birth", "dob", "Date_of_Birth") or (ctx.app or {}).get("date_of_birth")
        age = _age_from_dob(dob)
        _set(out, "age_years", age)
        return out


def _set(d: dict, key: str, value: Any) -> None:
    """Store only present values so absent params re-weight instead of scoring 0."""
    if value is not None:
        d[key] = value


def _public_record_type(result: dict) -> str:
    """Map bureau derogatory flags → the public_records scorecard category.
    TODO: confirm exact flag field names from the vendor sample response."""
    if _dig(result, "bankruptcy", "bankruptcyFlag"):
        return "bankruptcy_lt7"
    if _dig(result, "suit_filed", "suitFiled", "wilful_defaulter"):
        return "civil_judgment_lt5"
    if _dig(result, "write_off", "writeOff", "default_flag", "settled"):
        return "civil_judgment_gt5"
    return "none"


def get_vg_providers() -> list:
    """Real-mode provider bundle. Keeps the 4-provider / 4-pillar shape unchanged:
    VG adapters where a live endpoint exists; mock for banking_behaviour (no live
    API in this vendor set yet)."""
    from lrs.providers.mock import MockBankStmtProvider
    return [
        ExperianBureauProvider(),   # credit_bureau  — Experian Report
        ITRIncomeProvider(),        # income         — ITR Advance (partial)
        MockBankStmtProvider(),     # bank_statement — NO live endpoint yet (mock)
        PanKycProvider(),           # personal_profile — PAN Auth (+DigiLocker later)
    ]
