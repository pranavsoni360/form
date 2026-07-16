"""Normalise provider payloads + application data into canonical scorecard inputs.

Providers emit canonical `input_key` fields for their pillar; this module merges
them and derives the affordability + existing-obligation ratios that come from
the application itself. Output is the flat dict the engine consumes.
"""
from __future__ import annotations

from typing import Any

from lrs import decision

# Nominal ROI used only to ESTIMATE the proposed loan's EMI-to-income at scoring
# time (the real rate is set later in decision.decide).
_NOMINAL_ROI = 16.0
# Tenure assumed for the affordability estimate when the form didn't capture one.
_DEFAULT_TENURE_MONTHS = 24

# Keyword → loan_purpose category (used to pick the risk_premium product).
_PURPOSE_KEYWORDS = [
    ("home", "home_loan"), ("house", "home_loan"),
    ("auto", "auto_loan"), ("car", "auto_loan"), ("vehicle", "auto_loan"),
    ("consumer", "consumer_durable"), ("durable", "consumer_durable"),
    ("appliance", "consumer_durable"), ("phone", "consumer_durable"),
    ("laptop", "consumer_durable"), ("tv", "consumer_durable"),
]


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
    """Merge provider payloads + derive affordability/obligation ratios."""
    inputs: dict[str, Any] = {}
    for p in payloads:
        if p:
            inputs.update(p)

    # Document availability flags consumed by pillars._doc_cap.
    # A parameter with doc_required=true and no matching doc is capped at no_doc_max_score.
    app = app or {}
    for _doc_field in (
        "aadhaar_front_url", "aadhaar_back_url", "pan_card_url",
        "photo_url", "income_proof_url", "bank_statement_url",
    ):
        inputs[f"_doc_{_doc_field}"] = bool(app.get(_doc_field))

    requested_amount = _f(app.get("loan_amount_requested")) or 0.0
    nmi = _f(inputs.get("net_monthly_income")) \
        or _f(app.get("monthly_net_income")) \
        or _f(app.get("monthly_gross_income")) or 0.0
    existing_emi = _f(app.get("monthly_emi_existing")) \
        or _f(inputs.get("total_existing_emi")) or 0.0
    tenure_years = _f(app.get("repayment_period_years")) or 0.0

    if nmi > 0:
        # Existing obligations → personal_profile.existing_liabilities.
        existing_pct = round(existing_emi / nmi * 100, 2)
        inputs.setdefault("total_emi_pct_income", existing_pct)
        inputs.setdefault("dti_pct", existing_pct)
        # Proposed-loan EMI-to-income (affordability) → income pillar.
        if requested_amount > 0:
            months = int(tenure_years * 12) if tenure_years > 0 else _DEFAULT_TENURE_MONTHS
            new_emi = decision.emi(requested_amount, _NOMINAL_ROI, months)
            inputs.setdefault("new_loan_emi_to_income_pct", round(new_emi / nmi * 100, 2))

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
    """Consumer-durable / auto purposes → consumer_loan; else personal_loan."""
    purpose = map_loan_purpose(app.get("purpose_of_loan"))
    if purpose in ("auto_loan", "used_car_loan", "consumer_durable"):
        return "consumer_loan"
    return "personal_loan"
