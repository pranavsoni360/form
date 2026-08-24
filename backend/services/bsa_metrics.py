"""
Derive the `banking_behaviour` scorecard inputs from a Digitap type3 report.

This is the module that replaces MockBankStmtProvider, which currently feeds that
pillar (weight 20) FABRICATED numbers.

HONESTY RULE
A key is emitted only when the report genuinely supports it. Anything uncertain
is left OUT, so `pillars._doc_cap` re-weights around it — a missing input scores
nothing, whereas a guessed one silently moves a lending decision. `coverage`
reports what was and was not derivable so an officer can see the difference
between "healthy cash flow" and "we could not tell".

WHY SOME KEYS ARE NOT DERIVED YET
The only report captured so far came from the Account-Aggregator path with a
one-transaction sandbox statement: no salary credits, no EMIs, and an EMPTY
`loan_analysis`. The field NAMES below come from the vendor's documented
`analysis_data.Overall` block, not from anything observed carrying real values.
So every lookup is defensive and every absence is recorded rather than defaulted.
Once a real 6-month upload lands, `coverage.missing` says exactly what to revisit.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Digitap emits the same metric under several spellings, and empty string is used
# where a number is absent. Both are handled in _num/_first.
_SUMMARY_KEYS = ("request_level_summary_var", "bank_level_summary_var")


def _num(v: Any) -> Optional[float]:
    """Coerce to float, treating "" / None / non-numeric as absent (not zero)."""
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _first(d: dict, *names: str) -> Optional[float]:
    """
    First numeric value among several candidate key spellings.

    Needed because the report carries e.g. `LoanDisbursal`, `loanDisbursal` and
    `totalLoanDisbursal`, and `Total No. of I/W Bounced` alongside
    `Total No.of I / W Bounced`. Picking one blindly risks reading a key that
    happens to be absent in this report version.
    """
    for n in names:
        v = _num(d.get(n))
        if v is not None:
            return v
    return None


def _overall(report: dict) -> dict:
    """
    `analysis_data.Overall` for the first account, if present.

    This is where the underwriting fields live (salary, EMI, FOIR). It is per
    ACCOUNT, unlike the summary_var blocks which aggregate. Absent entirely in
    the sandbox capture, hence the empty-dict fallback.
    """
    for bank in (report.get("banks") or []):
        for acct in (bank.get("accounts") or []):
            ad = acct.get("analysis_data") or {}
            if isinstance(ad.get("Overall"), dict):
                return ad["Overall"]
    return {}


def _summary(report: dict) -> dict:
    """
    The compact per-request summary.

    Request level aggregates every bank; bank level is one bank. They were
    identical in the single-account capture but WILL diverge once a borrower
    links more than one account, so request level is preferred for
    whole-applicant metrics.
    """
    for k in _SUMMARY_KEYS:
        v = report.get(k)
        if isinstance(v, dict) and v:
            return v
    for bank in (report.get("banks") or []):
        v = bank.get("bank_level_summary_var")
        if isinstance(v, dict) and v:
            return v
    return {}


def _months(report: dict) -> float:
    """Statement span in months, floored at 1 so a short window cannot inflate."""
    days = _num(report.get("statement_period_days")) or 0
    return max(1.0, days / 30.44) if days else 1.0


def derive(report: dict) -> dict:
    """
    Map a type3 report onto scorecard input keys.

    Returns {"inputs": {...}, "coverage": {"derived": [...], "missing": [...]},
             "context": {...}} — `inputs` is what the LRS provider merges.
    """
    if not isinstance(report, dict):
        return {"inputs": {}, "coverage": {"derived": [], "missing": ["report_unreadable"]}}

    s = _summary(report)
    o = _overall(report)
    months = _months(report)

    inputs: dict[str, Any] = {}
    missing: list[str] = []

    # ── net_cash_flow (weight 50) — monthly credits minus debits ────────────
    credits = _first(s, "Total Amount of Credit Transactions")
    debits = _first(s, "Total Amount of Debit Transactions")
    if credits is not None and debits is not None:
        inputs["net_cash_flow"] = round((credits - debits) / months, 2)
    else:
        missing.append("net_cash_flow")

    # ── penalty_count (weight 30) — bounce EVENTS over the window ───────────
    # Prefer the non-technical count: a technical bounce is a bank-side failure,
    # not borrower behaviour, so counting it would penalise the wrong party.
    bounces = _first(o, "inw_chq_bounce_nonTechnical", "total_inw_chq_bounce_nonTechnical")
    if bounces is None:
        bounces = _first(
            s, "inw_chq_bounce_nonTechnical", "total_inw_chq_bounce_nonTechnical",
            "Total No. of I/W Bounced", "Total No.of I / W Bounced",
            "Total No. of I/W Chq Bounced",
        )
    outward = _first(s, "Total Number of Outward Cheque Bounces")
    if bounces is not None or outward is not None:
        inputs["penalty_count"] = int((bounces or 0) + (outward or 0))
    else:
        missing.append("penalty_count")

    # ── income, needed by two ratio keys ────────────────────────────────────
    # Prefer salary DETECTED in the statement over anything declared: that is the
    # whole point of analysing the statement. `Average Salary Amount` is monthly;
    # the total is divided by the window.
    # Every candidate is guarded on > 0, not on presence: the zero-filled fields
    # would otherwise make "no salary detected" look like "income of zero", and a
    # zero divisor silently kills the two ratio keys below.
    def _pos(*names: str) -> Optional[float]:
        v = _first(o, *names)
        return v if v and v > 0 else None

    nmi = _pos("Average Salary Amount")
    if nmi is None:
        total_sal = _pos("Total Amount of Salary Credits")
        if total_sal is not None:
            nmi = total_sal / months
    if nmi is None:
        # Deliberately NOT falling back to balance-based proxies: average balance
        # is not income, and using it would produce a confident-looking ratio
        # from an unrelated number.
        missing.append("net_monthly_income_not_detected")

    # ── amb_pct_of_nmi (weight 6) ───────────────────────────────────────────
    amb = _first(s, "Average EOD Balance") or _first(o, "Average EOD Balance", "Monthly Average Balance")
    if amb is not None and nmi and nmi > 0:
        inputs["amb_pct_of_nmi"] = round(amb / nmi * 100, 2)
    else:
        missing.append("amb_pct_of_nmi")

    # ── surplus_income_ratio (weight 50) ────────────────────────────────────
    # Digitap computes a surplus directly; fall back to (income - obligations).
    surplus = _first(o, "Average Surplus Amount")
    if surplus is None:
        total_surplus = _first(o, "Surplus Amount")
        if total_surplus is not None:
            surplus = total_surplus / months
    if surplus is not None and nmi and nmi > 0:
        inputs["surplus_income_ratio"] = round(surplus / nmi * 100, 2)
    else:
        missing.append("surplus_income_ratio")

    # ── otp_ratio_pct (40) and missed_payment_ratio (30) ────────────────────
    # NOT DERIVED. Both need payments MADE against payments DUE, and the report
    # gives only what was paid ("No. of EMI / loan payments"). `loan_analysis`
    # may carry the schedule, but it was an empty list in the only capture we
    # have, so there is nothing to verify a mapping against.
    #
    # Approximating these would put an invented number behind 70 of this
    # pillar's weight. Left missing so the pillar re-weights honestly.
    missing.extend(["otp_ratio_pct", "missed_payment_ratio"])

    # ── income-pillar extras, emitted only when genuinely present ───────────
    if nmi and nmi > 0:
        inputs["net_monthly_income"] = round(nmi, 2)
    # Digitap's own detection, mapped onto the scorecard's categories — but only
    # when the statement actually shows salary evidence. In the sandbox capture
    # "Employment Type" was present while salary_count/Salary Flag were not, so
    # trusting the label alone asserted "self-employed" from a one-transaction
    # file. An unsupported label is worse than none: this key carries weight 30 in
    # the income pillar.
    emp = o.get("Employment Type")
    # NOT `is not None`: analysis_data.Overall carries all ~488 fields ALWAYS,
    # zero-filled when nothing was detected. Presence proves the report was
    # generated, not that a salary exists — so the test has to be a non-zero
    # VALUE. (Confirmed on the sandbox capture: Salary Flag 0, salary_count 0.0,
    # yet "Employment Type" still read "Self-Employed".)
    has_salary_signal = any(
        (_first(o, k) or 0) > 0
        for k in ("salary_count", "Total No of Salary Credits", "Salary Flag",
                  "Total Amount of Salary Credits", "Average Salary Amount")
    )
    if isinstance(emp, str) and emp.strip() and has_salary_signal:
        low = emp.strip().lower()
        if "salar" in low:
            inputs["employment_type"] = "salaried_private_mnc"
        elif "self" in low:
            inputs["employment_type"] = "self_employed_stable"
    elif isinstance(emp, str) and emp.strip():
        missing.append("employment_type_unsupported_by_salary_data")

    context = {
        "statement_period_days": report.get("statement_period_days"),
        "months": round(months, 2),
        "source_of_data": report.get("source_of_data"),
        "multiple_accounts_found": report.get("multiple_accounts_found"),
        "has_analysis_data": bool(o),
        "detected_monthly_income": round(nmi, 2) if nmi else None,
    }

    # Six keys make up the banking_behaviour pillar; anything less is a partial
    # score. Logged with the ACTUAL count of pillar keys (not every emitted key —
    # net_monthly_income and employment_type belong to the income pillar and would
    # otherwise inflate this number).
    _PILLAR_KEYS = {
        "net_cash_flow", "surplus_income_ratio", "otp_ratio_pct",
        "missed_payment_ratio", "penalty_count", "amb_pct_of_nmi",
    }
    got = len(_PILLAR_KEYS & set(inputs))
    if got < len(_PILLAR_KEYS):
        logger.warning(
            "BSA: derived %d of %d banking_behaviour inputs (missing: %s)%s",
            got, len(_PILLAR_KEYS), ", ".join(sorted(set(missing))),
            "" if o else " - report carried no analysis_data.Overall",
        )

    return {
        "inputs": inputs,
        "coverage": {"derived": sorted(inputs.keys()), "missing": sorted(set(missing))},
        "context": context,
    }
