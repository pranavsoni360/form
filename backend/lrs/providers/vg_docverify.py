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
import html as _html
import json as _json
import logging
import os
import re as _re
from typing import Any

import httpx

from lrs.providers.base import FetchContext

logger = logging.getLogger("lrs-vg-docverify")

# ── Configuration ─────────────────────────────────────────────────────────────
#
# VG Docverify has TWO environments with DIFFERENT credentials, and the pair MUST
# match the host. Sending the production UserId to a UAT host returns
#     "For given User 25 API Rights Not Assigned"
# which reads like a provisioning problem but is really an environment mismatch —
# it cost real time to diagnose, so the credentials are now derived FROM the base
# URL instead of being set independently.
#
#   UAT   10.200.10.43 / galaxypay.in:9005   user 33  CONV27032026   VGIL
#   PROD  vpays.in                           user 25  COVAI27032026  VPAY
#
# SECURITY: these are shared bank credentials and they are in this file's git
# history. They belong in a secrets manager; the built-in table exists only so a
# misconfigured host fails loudly rather than silently using the wrong pair.
# Every value stays individually overridable for the case where VG rotates one.

_UAT_CREDS = {
    "user_id": "33",
    "verification_key": "CONV27032026",
    "bank_short_code": "VGIL",
    "bank_name": "VIRTUAL URBAN CO-OPERATIVE BANK LTD",
}
_PROD_CREDS = {
    "user_id": "25",
    "verification_key": "COVAI27032026",
    "bank_short_code": "VPAY",
    "bank_name": "Virtual Galaxy Fintech Pvt Ltd",
}

# Default to UAT: a wrong-environment call that leaks real applicant PAN/DOB to
# production is worse than one that fails in test.
_BASE_URL = os.getenv("VG_DOCVERIFY_BASE_URL", "http://10.200.10.43/VGDocverify").rstrip("/")


def _creds_for(base_url: str) -> dict:
    """
    Pick the credential set that belongs to this host.

    Matches on the hostname rather than a separate VG_DOCVERIFY_ENV flag, so the
    two can never disagree — the host is the single source of truth about which
    environment we are talking to.
    """
    host = base_url.lower()
    if "vpays.in" in host:
        return _PROD_CREDS
    if "10.200.10.43" in host or "galaxypay.in" in host:
        return _UAT_CREDS
    # An unrecognised host is most likely a new production endpoint, so assume
    # nothing and require the credentials to be supplied explicitly.
    logger.warning(
        "VG Docverify: unrecognised host %r — set VG_DOCVERIFY_USER_ID and "
        "VG_DOCVERIFY_VERIFICATION_KEY explicitly for this environment.", base_url,
    )
    return {"user_id": "", "verification_key": "", "bank_short_code": "", "bank_name": ""}


_C = _creds_for(_BASE_URL)
_USER_ID = os.getenv("VG_DOCVERIFY_USER_ID") or _C["user_id"]
_VERIFICATION_KEY = os.getenv("VG_DOCVERIFY_VERIFICATION_KEY") or _C["verification_key"]
_BANK_NAME = os.getenv("VG_DOCVERIFY_BANK_NAME") or _C["bank_name"]
_BANK_SHORT_CODE = os.getenv("VG_DOCVERIFY_BANK_SHORT_CODE") or _C["bank_short_code"]

# ExperianReport SOAP method + inner request element.
#
# CONFIRMED from the live WSDL (ProteanCredit.asmx?WSDL): the request is
#     <experianreport><obj>{pan, firstName, ... UserId, VerificationKey}</obj></experianreport>
# i.e. `obj` is a SINGLE PCrdBo whose children are the parameters themselves.
# There is NO inner repeating element.
#
# _soap_envelope() already hardcodes the <obj> wrapper, so the inner element must
# be EMPTY here — the old default of "experian" produced <obj><experian>…</obj>,
# an element the schema does not define. (Setting this to "obj" instead is the
# other wrong answer: it yields <obj><obj>…</obj></obj>.)
_EXPERIAN_METHOD = os.getenv("VG_EXPERIAN_METHOD", "experianreport")
_EXPERIAN_ELEM = os.getenv("VG_EXPERIAN_ELEM", "")
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


def _parse_lenient_json(text: str) -> Any:
    """Parse a JSON response, tolerating a valid JSON value followed by EXTRA
    data. Some VG / galaxypay endpoints append a second concatenated object or
    trailing text, which makes a strict parse raise 'Extra data: ...'. Recover the
    first complete JSON value and ignore the rest. Genuinely non-JSON bodies still
    raise (so the caller retries)."""
    s = (text or "").strip()
    try:
        return _json.loads(s)
    except _json.JSONDecodeError:
        obj, _end = _json.JSONDecoder().raw_decode(s)  # first value; raises if not JSON at all
        logger.warning(
            "VG Docverify: response had %d trailing chars after the JSON value; "
            "used the first value.", len(s) - _end,
        )
        return obj


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
        data = _parse_lenient_json(resp.text)
    except (httpx.HTTPError, ValueError) as e:
        # Network error / 5xx / genuinely-unparseable body → transient: retry.
        logger.warning("VG Docverify %s call failed: %s", api_code, e)
        raise
    # Envelope: {"requestId": ..., "result": {...|[...]}, "statusCode": 101}
    result = data.get("result") if isinstance(data, dict) else None
    if not result:
        logger.info("VG Docverify %s returned no result (statusCode=%s)",
                    api_code, data.get("statusCode") if isinstance(data, dict) else "?")
        return None
    return result if isinstance(result, dict) else {"_list": result}


# ── SOAP transport ────────────────────────────────────────────────────────────
# The vpays.in VGKVerify/ProteanCredit .asmx endpoints are SOAP, not JSON: they
# reject a JSON POST ("Root element is missing"). The real payload is a JSON
# STRING returned inside the <MethodResponse> element of the SOAP envelope.
# Verified live against ProteanCredit.asmx/experianreport and VGKVerify.asmx/Pan.

def _soap_envelope(method: str, inner_element: str, rows: list[dict]) -> str:
    """Build a SOAP 1.1 envelope: <method><obj>[<inner_element>]…</obj></method>.

    `inner_element` may be EMPTY, which emits the parameters as direct children of
    <obj>. That is the shape ProteanCredit/experianreport requires: its WSDL
    declares obj as a single PCrdBo whose children are the parameters. Endpoints
    whose obj is a repeating list (VGKVerify's <kpan> etc.) pass a name.
    """
    def _rowxml(row: dict) -> str:
        cells = "".join(
            f"<{k}>{_html.escape(str(v))}</{k}>" for k, v in row.items() if v is not None
        )
        return f"<{inner_element}>{cells}</{inner_element}>" if inner_element else cells
    body = "".join(_rowxml(r) for r in rows)
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
        "<soap:Body>"
        f'<{method} xmlns="http://tempuri.org/">'
        f"<obj>{body}</obj>"
        f"</{method}>"
        "</soap:Body></soap:Envelope>"
    )


def _extract_soap_payload(xml_text: str) -> dict | None:
    """Pull the JSON payload VG returns inside the SOAP <...Response> element.

    VG wraps a JSON string in the response body, e.g.
      <PanResponse>{"statusCode":200,"data":{...}}</PanResponse>
    (sometimes HTML-escaped). Returns the parsed dict, or None if empty/parse-fail.
    Also surfaces SOAP <faultstring> as a raised error for the caller's retry.
    """
    if not xml_text:
        return None
    fault = _re.search(r"<faultstring>(.*?)</faultstring>", xml_text, _re.S)
    if fault:
        raise RuntimeError(f"SOAP fault: {_html.unescape(fault.group(1)).strip()[:300]}")

    # A gateway error can be emitted as JSON *before* the SOAP envelope, leaving
    # the <...Response> element EMPTY:
    #     {"message":"API rate limit exceeded"}<?xml ...><experianreportResponse/>
    # Confirmed live against ProteanCredit. Without this branch the empty
    # Response parses to None, which the providers read as "applicant has no
    # record" — so a rate-limited or throttled call would silently score as a
    # clean bureau miss and the pillar would re-weight around it. Raise instead,
    # so the job worker retries.
    stripped = xml_text.lstrip()
    if stripped.startswith("{"):
        try:
            pre, end = _json.JSONDecoder().raw_decode(stripped)
        except ValueError:
            pre, end = None, 0
        if isinstance(pre, dict) and pre.get("message") and "<" in stripped[end:]:
            raise RuntimeError(f"VG gateway error: {str(pre.get('message'))[:200]}")
    # Grab the text inside the first *Response element (any namespace prefix).
    m = _re.search(r"<\w*Response[^>]*>(.*?)</\w*Response>", xml_text, _re.S)
    inner = m.group(1) if m else xml_text
    inner = _html.unescape(inner).strip()
    if not inner:
        return None
    try:
        parsed = _json.loads(inner)
    except (ValueError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else {"_list": parsed}


async def _post_soap(
    url: str, method: str, inner_element: str, ctx: FetchContext,
    fields: dict, api_code: str | None = None,
) -> dict | None:
    """POST a SOAP request and return the parsed JSON payload (or None if absent).

    Merges the shared credential block (incl. APICode) into the row, exactly like
    the JSON path — the server requires APICode even though the WSDL omits it.
    Raises on network / 5xx / SOAP fault so the job worker retries.
    """
    row = {**_common_params(api_code or method, ctx), **fields}
    envelope = _soap_envelope(method, inner_element, [row])
    headers = {
        "Content-Type": "text/xml; charset=utf-8",
        "SOAPAction": f'"http://tempuri.org/{method}"',
    }
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(url, content=envelope.encode("utf-8"), headers=headers)
        resp.raise_for_status()
    except httpx.HTTPError as e:
        logger.warning("VG SOAP %s call failed: %s", method, e)
        raise
    payload = _extract_soap_payload(resp.text)
    if not payload:
        logger.info("VG SOAP %s returned empty payload", method)
        return None
    # VG envelope: {"statusCode":200,"message":"SUCCESS","data":{...}}
    sc = payload.get("statusCode")
    if sc not in (200, 101, None):
        logger.info("VG SOAP %s non-success statusCode=%s message=%s",
                    method, sc, str(payload.get("message"))[:200])
        return None
    return payload


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
        # SOAP on ProteanCredit.asmx. Returns {"statusCode":200,"data":
        # {"jsonExperianReport": {...CAIS report...}}}. The inner request element
        # name (_EXPERIAN_ELEM) is confirmable from ?op=experianreport; kept in an
        # env override so it can be corrected without a code change.
        first, last = _split_name((ctx.app or {}).get("customer_name"))
        return await _post_soap(
            _PROTEAN, _EXPERIAN_METHOD, _EXPERIAN_ELEM, ctx,
            {
                "phoneNumber": ctx.phone or "",
                "pan": ctx.pan or "",
                "firstName": first,
                "lastName": last,
                "dateOfBirth": _fmt_date((ctx.app or {}).get("date_of_birth")),
                "pincode": str((ctx.app or {}).get("pincode", "")),
            },
            api_code="ExperianReport",
        )

    async def pan(self, ctx: FetchContext) -> dict | None:
        # SOAP on VGKVerify.asmx. Inner element <kpan>, needs PanNo + APICode.
        return await _post_soap(
            _VGK, "Pan", "kpan", ctx, {"PanNo": ctx.pan or ""}, api_code="pancard",
        )

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

def _yyyymmdd_to_date(v: Any) -> _dt.date | None:
    """CIBIL dates are ints like 20240119. Parse to a date (None if unusable)."""
    s = str(v or "").strip()
    if len(s) != 8 or not s.isdigit():
        return None
    try:
        return _dt.date(int(s[:4]), int(s[4:6]), int(s[6:8]))
    except ValueError:
        return None


def _derive_bureau_from_cais(report: dict) -> dict[str, Any]:
    """Derive the credit_bureau pillar inputs from an Experian/CIBIL CAIS report.

    VG's ExperianReport carries NO bureau score — only account details — so every
    scorecard input is derived from CAIS_Account. `credit_score` is intentionally
    NOT set (that parameter is disabled/absent and the pillar re-weights).
    Verified against a real vpays.in response (report V2.4).
    """
    out: dict[str, Any] = {}
    cais = report.get("CAIS_Account") or {}
    summary = (cais.get("CAIS_Summary") or {}).get("Credit_Account") or {}
    balances = (cais.get("CAIS_Summary") or {}).get("Total_Outstanding_Balance") or {}
    accounts = cais.get("CAIS_Account_DETAILS") or []
    if isinstance(accounts, dict):  # single-account payloads may not be a list
        accounts = [accounts]

    # active loans (direct)
    active = _num(summary.get("CreditAccountActive"))
    _set(out, "active_loans_count", active)

    # credit history length: years since the earliest Open_Date across accounts
    open_dates = [d for d in (_yyyymmdd_to_date(a.get("Open_Date")) for a in accounts) if d]
    if open_dates:
        earliest = min(open_dates)
        today = _dt.date.today()
        years = (today - earliest).days / 365.25
        _set(out, "credit_history_years", round(years, 2))

    # utilization: total outstanding / total sanctioned limit (revolving)
    total_limit = sum(_num(a.get("Credit_Limit_Amount")) or 0 for a in accounts)
    outstanding_all = _num(balances.get("Outstanding_Balance_All"))
    if total_limit > 0 and outstanding_all is not None:
        util = round(outstanding_all / total_limit * 100, 2)
        _set(out, "credit_utilization_pct", util)
        _set(out, "cc_utilization_pct", util)

    # on-time payment %: share of reported months with Days_Past_Due == 0
    total_months, ontime_months = 0, 0
    for a in accounts:
        for h in (a.get("CAIS_Account_History") or []):
            dpd = _num(h.get("Days_Past_Due"))
            if dpd is None:
                continue
            total_months += 1
            if dpd == 0:
                ontime_months += 1
    if total_months > 0:
        _set(out, "on_time_payment_pct", round(ontime_months / total_months * 100, 2))

    # total existing EMI: sum of scheduled monthly payments (loans; cards report "")
    total_emi = sum(_num(a.get("Scheduled_Monthly_Payment_Amount")) or 0 for a in accounts)
    if total_emi > 0:
        _set(out, "total_existing_emi", round(total_emi, 2))

    # public records / derogatory: worst flag across summary + accounts
    out["public_record_type"] = _cais_public_record_type(summary, accounts)
    return out


def _cais_public_record_type(summary: dict, accounts: list) -> str:
    """Map CAIS default / suit-filed / write-off / settled flags → scorecard category."""
    defaults = _num(summary.get("CreditAccountDefault")) or 0
    suit_balance = _num(summary.get("CADSuitFiledCurrentBalance")) or 0
    worst = "none"
    for a in accounts:
        if _dig(a, "SuitFiled_WillfulDefault", "SuitFiledWillfulDefaultWrittenOffStatus"):
            worst = "civil_judgment_lt5"
        wo = _dig(a, "Written_off_Settled_Status")
        if wo:
            worst = "civil_judgment_gt5" if worst == "none" else worst
    if suit_balance > 0:
        worst = "civil_judgment_lt5"
    # A hard default with no explicit suit/writeoff still counts as adverse.
    if defaults > 0 and worst == "none":
        worst = "civil_judgment_gt5"
    return worst


class ExperianBureauProvider:
    """Credit-bureau pillar, backed by VG's ExperianReport (CIBIL CAIS) endpoint.

    The response is an account-level CAIS report with NO bureau score, so all
    pillar inputs are DERIVED from the accounts (see _derive_bureau_from_cais):
    payment history, utilization, credit-age, active loans, and derogatory flags.
    `credit_score` is deliberately not populated — the scorecard re-weights it out.
    """
    name = "bureau"
    pillar = "credit_bureau"

    async def fetch(self, ctx: FetchContext) -> dict[str, Any]:
        if not ctx.pan and not ctx.phone:
            return {}
        result = await _client.experian_report(ctx)
        if not result:
            return {}
        # SOAP payload shape: {"statusCode":200,"data":{"jsonExperianReport":{...}}}
        report = ((result.get("data") or {}).get("jsonExperianReport")) or {}
        if not report:
            logger.info("Experian: no jsonExperianReport in payload (keys=%s)", list(result)[:6])
            return {}
        return _derive_bureau_from_cais(report)


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
