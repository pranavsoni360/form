"""Decision + risk-based pricing.

Turns the engine's total score into a lending decision and an offer:
  - decision       : approve | refer | reject (score thresholds from config)
  - interest_rate  : base_roi + risk_premium (from the score's risk band)
  - recommended_amount / tenure / emi : bounded by the borrower's repayment
    capacity (FOIR) and the product's amount/tenure limits.

EMI  = P·r / (1 - (1+r)^-n)                (r = monthly rate = roi/1200)
Capacity (max principal) = A·(1 - (1+r)^-n) / r   (annuity PV of affordable EMI A)
These mirror the reference fn_to_get_emi / fn_get_borrower_capacity.
"""
from __future__ import annotations

from dataclasses import dataclass

from lrs import scorecard

# Fixed Obligation to Income Ratio: max share of net income that may go to EMIs
# (existing + new). Tunable; standard retail-lending default.
DEFAULT_FOIR = 0.50


@dataclass
class DecisionResult:
    decision: str                 # approve | refer | reject
    interest_rate: float          # annual %, base + risk premium
    risk_band: str                # band label (Excellent..Poor)
    recommended_amount: float
    recommended_tenure_m: int
    recommended_emi: float
    max_affordable_emi: float
    capacity_amount: float        # principal supportable by FOIR (pre-clamp)


def emi(principal: float, annual_roi: float, months: int) -> float:
    """Standard reducing-balance EMI."""
    if months <= 0:
        return 0.0
    r = annual_roi / 1200.0
    if r == 0:
        return principal / months
    factor = (1 + r) ** (-months)
    return principal * r / (1 - factor)


def principal_for_emi(affordable_emi: float, annual_roi: float, months: int) -> float:
    """Max principal whose EMI ≤ affordable_emi (annuity present value)."""
    if months <= 0 or affordable_emi <= 0:
        return 0.0
    r = annual_roi / 1200.0
    if r == 0:
        return affordable_emi * months
    factor = (1 + r) ** (-months)
    return affordable_emi * (1 - factor) / r


def _band_for(score: float, bands: list[dict]) -> dict:
    for b in bands:
        if float(b["min_score"]) <= score <= float(b["max_score"]):
            return b
    # Defensive: config is validated to cover 0..100, but clamp just in case.
    return min(bands, key=lambda b: abs(float(b["min_score"]) - score))


def decide(
    total_score: float,
    *,
    product_key: str | None = None,
    requested_amount: float,
    requested_tenure_months: int,
    net_monthly_income: float,
    existing_emi: float = 0.0,
    foir: float = DEFAULT_FOIR,
    scorecard_cfg: dict | None = None,
    risk_cfg: dict | None = None,
    missing_pillars: list[str] | None = None,
) -> DecisionResult:
    sc = scorecard_cfg or scorecard.load_scorecard()
    rc = risk_cfg or scorecard.load_risk_premium()

    product_key = product_key or rc.get("default_product")
    product = rc["products"].get(product_key) or rc["products"][rc["default_product"]]

    band = _band_for(total_score, product["bands"])
    roi = float(product["base_roi"]) + float(band["risk_premium"])

    th = sc["decision_thresholds"]
    if total_score >= th["approve"]:
        decision = "approve"
    elif total_score >= th["refer"]:
        decision = "refer"
    else:
        decision = "reject"

    # Thin-file guard: never AUTO-APPROVE when the credit-bureau signal (the
    # dominant risk pillar) is absent. With no bureau data the score can be
    # driven entirely by weak/derived signals (e.g. a defaulted-to-zero DTI
    # scoring 100), so route these to manual review instead of auto-approval.
    if decision == "approve" and missing_pillars and "credit_bureau" in missing_pillars:
        decision = "refer"

    tenure = int(min(requested_tenure_months or 0, product["max_tenure_months"]))
    if tenure <= 0:
        tenure = int(product["max_tenure_months"])

    # Clamp existing EMI to ≥0 so a stray negative can't inflate repayment capacity.
    max_emi = max(0.0, net_monthly_income * foir - max(0.0, existing_emi or 0.0))
    capacity = principal_for_emi(max_emi, roi, tenure)

    rec_amount = min(float(requested_amount or 0), capacity)
    rec_amount = max(0.0, min(rec_amount, float(product["max_amount"])))
    # If capacity can't meet the product floor, there's nothing viable to offer.
    if rec_amount < float(product["min_amount"]):
        if decision == "approve":
            decision = "refer"  # eligible on risk, but capacity too low — needs review
    rec_emi = emi(rec_amount, roi, tenure)

    return DecisionResult(
        decision=decision,
        interest_rate=round(roi, 2),
        risk_band=band.get("label", ""),
        recommended_amount=round(rec_amount, 2),
        recommended_tenure_m=tenure,
        recommended_emi=round(rec_emi, 2),
        max_affordable_emi=round(max_emi, 2),
        capacity_amount=round(capacity, 2),
    )
