"""Normalise provider payloads + application data into canonical scorecard inputs.

Providers emit canonical `input_key` fields for their pillar; this module merges
them and derives the loan-specific + ratio fields that come from the application
itself (requested amount, tenure, purpose, income-relative ratios). The output
is the flat dict the engine consumes.
"""
from __future__ import annotations

from typing import Any

from lrs import decision

# Nominal ROI used only to ESTIMATE the proposed loan's EMI-to-income at scoring
# time (the real rate is set later in decision.decide). Kept deliberately simple.
_NOMINAL_ROI = 13.0

# Keyword → loan_purpose category (scorecard.json loan_specific.loan_purpose).
_PURPOSE_KEYWORDS = [
    ("home", "home_loan"),
    ("house", "home_loan"),
    ("auto", "auto_loan"),
    ("car", "auto_loan"),
    ("vehicle", "auto_loan"),
    ("education", "education_low_tier"),
    ("business", "business_expansion"),
    ("consolidat", "debt_consolidation"),
    ("wedding", "personal_loan"),
    ("marriage", "personal_loan"),
    ("travel", "personal_loan"),
    ("medical", "personal_loan"),
    ("crypto", "speculation"),
    ("stock", "speculation"),
    ("trading", "speculation"),
]

_INCOME_GENERATING_PURPOSES = {"business_expansion", "auto_loan", "home_loan"}
_ESSENTIAL_PURPOSES = {"home_loan", "education_low_tier", "education_top_institute", "auto_loan"}
_SECURED_PURPOSES = {"home_loan", "auto_loan", "used_car_loan"}


def _f(v) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def map_loan_purpose(text: str | None) -> str:
    t = (text or "").strip().lower()
    for kw, cat in _PURPOSE_KEYWORDS:
        if kw in t:
            return cat
    return "personal_loan"


def to_canonical_inputs(app: dict, payloads: list[dict]) -> dict[str, Any]:
    """Merge provider payloads + derive application-based fields → engine inputs."""
    inputs: dict[str, Any] = {}
    for p in payloads:
        if p:
            inputs.update(p)

    app = app or {}
    requested_amount = _f(app.get("loan_amount_requested")) or 0.0
    nmi = _f(inputs.get("net_monthly_income")) \
        or _f(app.get("monthly_net_income")) \
        or _f(app.get("monthly_gross_income")) or 0.0
    annual_income = _f(inputs.get("annual_income")) or (nmi * 12)
    existing_emi = _f(app.get("monthly_emi_existing")) \
        or _f(inputs.get("total_existing_emi")) or 0.0
    tenure_years = _f(app.get("repayment_period_years")) or 0.0

    # Ratios (guard divide-by-zero).
    if annual_income > 0:
        lti = round(requested_amount / annual_income, 3)
        inputs.setdefault("loan_to_income_x", lti)
        inputs.setdefault("loan_amount_to_annual_income_x", lti)
    if nmi > 0:
        # Existing-obligation ratio → personal_profile.existing_liabilities.
        # (bank_statement's own emi_to_income_pct comes from the statement provider.)
        existing_pct = round(existing_emi / nmi * 100, 2)
        inputs.setdefault("total_emi_pct_income", existing_pct)
        inputs.setdefault("dti_pct", existing_pct)
        # Proposed-loan EMI-to-income (estimate) → loan_specific.
        if requested_amount > 0 and tenure_years > 0:
            months = int(tenure_years * 12)
            new_emi = decision.emi(requested_amount, _NOMINAL_ROI, months)
            inputs.setdefault("new_loan_emi_to_income_pct", round(new_emi / nmi * 100, 2))

    inputs.setdefault("tenure_years", tenure_years)

    # Loan-specific categoricals from the application.
    purpose = map_loan_purpose(app.get("purpose_of_loan"))
    inputs.setdefault("loan_purpose", purpose)
    inputs.setdefault(
        "secured_unsecured",
        "secured" if purpose in _SECURED_PURPOSES else "unsecured",
    )
    inputs.setdefault(
        "income_generating",
        "income_generating" if purpose in _INCOME_GENERATING_PURPOSES else "not_generating",
    )
    inputs.setdefault(
        "essential_discretionary",
        "essential" if purpose in _ESSENTIAL_PURPOSES else "discretionary",
    )
    # LTV only meaningful for secured; default 0 (unsecured).
    inputs.setdefault("ltv_pct", 0)

    return inputs


def decision_inputs(app: dict, inputs: dict) -> dict:
    """Extract the fields decision.decide() needs, from app + canonical inputs."""
    app = app or {}
    nmi = _f(inputs.get("net_monthly_income")) \
        or _f(app.get("monthly_net_income")) \
        or _f(app.get("monthly_gross_income")) or 0.0
    existing_emi = _f(app.get("monthly_emi_existing")) \
        or _f(inputs.get("total_existing_emi")) or 0.0
    requested_amount = _f(app.get("loan_amount_requested")) or 0.0
    tenure_years = _f(app.get("repayment_period_years")) or 0.0
    return {
        "product_key": _product_for(app),
        "requested_amount": requested_amount,
        "requested_tenure_months": int(tenure_years * 12) if tenure_years else 0,
        "net_monthly_income": nmi,
        "existing_emi": existing_emi,
    }


def _product_for(app: dict) -> str:
    """Choose the risk_premium product. Consumer-durable purposes → consumer_loan."""
    purpose = map_loan_purpose(app.get("purpose_of_loan"))
    if purpose in ("auto_loan", "used_car_loan"):
        return "consumer_loan"
    return "personal_loan"
