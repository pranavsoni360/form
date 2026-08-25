"""
Digitap bank-statement analysis via VGDocverify's AcAggregator.asmx.

Transport + journey client. Every shape here is taken from live captures against
`http://10.200.10.43/VGDocverify/AcAggregator.asmx` — see
docs/ACAGGREGATOR_API_CAPTURES.md for the raw bodies and for the four places the
vendor spec disagrees with what the API actually does.

WHY THIS IS NOT AN LRS PROVIDER
Every other provider is synchronous: fetch(ctx) -> metrics. This is a borrower
journey — issue a link, the borrower leaves and uploads a PDF at Digitap, a
callback fires minutes or hours later, then two more calls retrieve the data.
None of that fits inside a scoring call, so the journey is persisted
(migration_v42 `bsa_fetches`) and the LRS provider reads the last completed row.

CALL BUDGET
Three calls per journey is Digitap's floor: Generateurl -> statuscheck ->
retrievereport. There is no endpoint that takes a request and returns a report.
The callback is what removes POLLING — it tells us when to make calls 2 and 3.
`InstitutionList` is reference data and is cached, not fetched per application.

TRANSPORT QUIRKS (all confirmed, all load-bearing)
  1. Every body is `<payload>{"d":null}` — two concatenated JSON documents,
     because the ASMX method writes its payload and ASP.NET appends its own.
     json.loads() raises "Extra data"; raw_decode() is required.
  2. HTTP status is ALWAYS 200, including for errors. The `status` field inside
     the body is the only real signal.
  3. The request envelope is `{"obj": {...}}` — a bare object. The sibling
     VGKVerify APIs use `{"obj": [{...}]}` (an array, plus a credential block),
     so their `_post` helper cannot be reused here.
  4. No authentication of any kind was observed on any AcAggregator call.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

_TIMEOUT = 60.0  # retrievereport returns ~100KB and is the slow one


# ── errors ───────────────────────────────────────────────────────────────────

class AcAggregatorError(Exception):
    """A vendor-reported error. `code` is Digitap's own, e.g. TxnNotFound."""

    def __init__(self, code: str, message: str, raw: Any = None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.raw = raw


class AcAggregatorTransportError(Exception):
    """Network failure or an unparseable body — transient, so callers retry."""


# ── transport ────────────────────────────────────────────────────────────────

def parse_double_json(text: str) -> Any:
    """
    Read the first JSON document and discard ASP.NET's trailing `{"d":null}`.

    Mirrors json.JSONDecoder().raw_decode(). A body that is not JSON at all still
    raises, so a proxy error page cannot be mistaken for a vendor response.
    """
    s = (text or "").strip()
    if not s:
        raise AcAggregatorTransportError("empty response body")
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        try:
            obj, end = json.JSONDecoder().raw_decode(s)
        except json.JSONDecodeError as e:
            raise AcAggregatorTransportError(f"unparseable body: {s[:200]}") from e
        trailing = s[end:].strip()
        # The only expected tail is {"d":null}; anything else is worth knowing.
        if trailing and trailing != '{"d":null}' and trailing != '{"d": null}':
            logger.warning("AcAggregator: unexpected trailing data %r", trailing[:120])
        return obj


def _raise_if_error(data: Any) -> dict:
    """
    Turn the vendor's error envelope into an exception.

    Shape:
        {"status":"error","message":"400-Bad Request",
         "result":{"status":"error","code":"...","msg":"..."}}

    The outer `message` is a generic HTTP-ish string; `result.code` is the useful
    part. `result.msg` is sometimes an OBJECT of per-field messages (confirmed for
    InputValidationError), so it is stringified rather than assumed to be text.
    """
    if not isinstance(data, dict):
        raise AcAggregatorTransportError(f"expected an object, got {type(data).__name__}")
    if data.get("status") == "error":
        result = data.get("result") or {}
        code = str(result.get("code") or data.get("message") or "UnknownError")
        msg = result.get("msg")
        if not isinstance(msg, str):
            msg = json.dumps(msg) if msg is not None else str(data.get("message") or "")
        raise AcAggregatorError(code, msg, raw=data)
    return data


async def _call(base_url: str, method: str, obj: dict) -> dict:
    """POST one `{"obj": {...}}` request and return the parsed body."""
    url = f"{base_url.rstrip('/')}/{method}"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(url, json={"obj": obj})
        # Status is always 200, but a proxy or a dead host will not be.
        resp.raise_for_status()
    except httpx.HTTPError as e:
        raise AcAggregatorTransportError(f"{method} request failed: {e}") from e
    return _raise_if_error(parse_double_json(resp.text))


# ── results ──────────────────────────────────────────────────────────────────

@dataclass
class Institution:
    digitap_id: int
    name: str
    inst_type: Optional[str]
    form26as_enabled: bool
    username_regex: Optional[str]


@dataclass
class GeneratedLink:
    url: str
    request_id: str
    expires_at: Optional[datetime]


@dataclass
class TxnAttempt:
    """One entry from statuscheck's `txn_status` array."""
    txn_id: Optional[str]
    status: Optional[str]   # "Success" | "Failure" | (others unknown)
    code: Optional[str]     # "ReportGenerated" | "AAFIDataStatusError" | ...
    msg: Optional[str]

    @property
    def succeeded(self) -> bool:
        return (self.status or "").lower() == "success"

    @property
    def failed(self) -> bool:
        return (self.status or "").lower() == "failure"


@dataclass
class StatusResult:
    """
    Outcome of a statuscheck.

    `not_found` deserves care: Digitap creates no transaction until the borrower
    actually opens the link, so a brand-new request returns TxnNotFound too. It
    means "pending" while the link is unexpired and only "failed" afterwards —
    the caller decides using expires_at, because only it knows that.
    """
    attempts: list[TxnAttempt]
    not_found: bool = False
    raw: Any = None

    @property
    def successful_txn_id(self) -> Optional[str]:
        """
        First successful attempt's txn_id.

        Scanning matters: one request_id can produce several attempts, and in the
        captured sample the FAILURE came first. Reading attempts[0] would have
        abandoned a journey that actually succeeded.
        """
        for a in self.attempts:
            if a.succeeded and a.txn_id:
                return a.txn_id
        return None

    @property
    def all_failed(self) -> bool:
        """True only when there is at least one attempt and none can still progress."""
        return bool(self.attempts) and all(a.failed for a in self.attempts)

    @property
    def in_progress(self) -> bool:
        """
        An attempt exists that is neither success nor failure.

        The full set of status values is unknown, so anything unrecognised counts
        as still-working. Failing a live application on an unseen status string
        would be the worse error.
        """
        return any(not a.succeeded and not a.failed for a in self.attempts)


# ── client ───────────────────────────────────────────────────────────────────

class AcAggregatorClient:
    """Stateless wrapper over the four endpoints. One instance per base_url."""

    def __init__(self, base_url: str, api_key: Optional[str] = None):
        self.base_url = base_url
        # Reserved: no auth observed on any call. If production introduces a key
        # it is threaded here rather than sprinkled through the call sites.
        self.api_key = api_key

    # 1 ── reference data (cached; not part of the per-application budget) ────
    async def institution_list(self, list_type: str = "Statement") -> list[Institution]:
        data = await _call(self.base_url, "InstitutionList", {"type": list_type})
        out: list[Institution] = []
        for row in data.get("data") or []:
            if not isinstance(row, dict):
                continue
            try:
                digitap_id = int(row.get("id"))
            except (TypeError, ValueError):
                logger.warning("AcAggregator: institution with unusable id %r", row.get("id"))
                continue
            out.append(Institution(
                digitap_id=digitap_id,
                name=str(row.get("name") or "").strip(),
                inst_type=row.get("inst_type"),
                form26as_enabled=bool(row.get("form26as_enabled")),
                # Absent from EVERY Statement row and most NetBanking rows, so
                # .get() rather than [] — and never used for validation, because
                # several present values have stripped backslashes and are
                # silently wrong rather than broken.
                username_regex=row.get("username_regex"),
            ))
        return out

    # 2 ── start a journey ───────────────────────────────────────────────────
    async def generate_upload_url(
        self,
        *,
        institution_id: int | str,
        start_month: str,
        end_month: str,
        callback_url: str,
        return_url: str,
        acceptance_policy: str = "atLeastOneTransactionInRange",
        relaxation_days: int = 0,
    ) -> GeneratedLink:
        """
        Statement-upload journey for ONE institution.

        `institution_id` must be a single id. The documented regex permits a
        comma-separated list, but Digitap rejects one with InvalidInstitution
        (confirmed) — a borrower with two banks needs two journeys.

        It must also match the bank that actually issued the PDF: Digitap
        template-matches per bank, and a mismatch fails inside their own UI with
        error 065, which never reaches us. That is why the borrower picks the
        bank rather than an officer guessing.
        """
        data = await _call(self.base_url, "Generateurl", {
            "txn_completed_cburl": callback_url,
            "start_month": start_month,
            "end_month": end_month,
            "institution_id": str(institution_id),
            "destination": "statementupload",
            "return_url": return_url,
            "acceptance_policy": acceptance_policy,
            "relaxation_days": str(relaxation_days),
        })
        return self._link_from(data)

    async def generate_aa_url(
        self,
        *,
        mobile_num: str,
        fi_startdate: str,
        fi_enddate: str,
        callback_url: str,
        return_url: str,
        aa_vendor: str = "anumati",
        fetch_type: str = "ONETIME",
        fi_types: str = "DEPOSIT",
    ) -> GeneratedLink:
        """
        Account-Aggregator journey. Kept for completeness — Finix uses the upload
        path, because cooperative banks appear in the Statement institution list
        but not in the NetBanking one.
        """
        data = await _call(self.base_url, "Generateurl", {
            "txn_completed_cburl": callback_url,
            "destination": "accountaggregator",
            "return_url": return_url,
            "mobile_num": mobile_num,
            "aa_vendor": aa_vendor,
            "aa_fetch_type": fetch_type,
            "aa_fi_types": fi_types,
            "aa_fi_startdate": fi_startdate,
            "aa_fi_enddate": fi_enddate,
        })
        return self._link_from(data)

    @staticmethod
    def _link_from(data: dict) -> GeneratedLink:
        url = data.get("url")
        request_id = data.get("request_id")
        if not url or request_id is None:
            raise AcAggregatorTransportError(f"Generateurl returned no url/request_id: {data}")
        expires = None
        raw_expires = data.get("expires")
        if raw_expires:
            try:
                # ISO with microseconds and no timezone; treated as UTC.
                expires = datetime.fromisoformat(str(raw_expires)).replace(tzinfo=timezone.utc)
            except ValueError:
                logger.warning("AcAggregator: unparseable expires %r", raw_expires)
        # int from Generateurl but echoed as a string by statuscheck — normalise.
        return GeneratedLink(url=str(url), request_id=str(request_id), expires_at=expires)

    # 3 ── has the borrower finished? ────────────────────────────────────────
    async def status_check(self, request_id: str) -> StatusResult:
        try:
            data = await _call(self.base_url, "statuscheck", {"request_id": str(request_id)})
        except AcAggregatorError as e:
            if e.code == "TxnNotFound":
                # NOT necessarily an error: also returned before the borrower
                # engages at all. The caller decides using expires_at.
                return StatusResult(attempts=[], not_found=True, raw=e.raw)
            raise
        attempts = [
            TxnAttempt(
                txn_id=row.get("txn_id"),
                status=row.get("status"),
                code=row.get("code"),
                msg=row.get("msg"),
            )
            for row in (data.get("txn_status") or [])
            if isinstance(row, dict)
        ]
        return StatusResult(attempts=attempts, raw=data.get("txn_status"))

    # 4 ── fetch the report ─────────────────────────────────────────────────
    async def retrieve_report(self, txn_id: str, subtype: str = "type3") -> dict:
        """
        Fetch the analysed statement.

        Always type3: it is type1 plus the computed summaries and analysis blocks
        that scoring needs. (type2 and type3 came back BYTE-IDENTICAL in testing,
        so the documented three subtypes are really two.)

        PII WARNING: the result contains unmasked name, email, phone, PAN,
        address, DOB and every transaction narration, plus a presigned S3 URL to
        the raw report. Never log it; never return it from a public API.
        """
        return await _call(self.base_url, "retrievereport", {
            "txn_id": txn_id,
            "report_type": "json",
            "report_subtype": subtype,
        })
