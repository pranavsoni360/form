"""Deterministic mock providers.

Produce stable, plausible pillar data seeded from the applicant's PAN (so the
same applicant always scores the same) and overlaid with real form values where
present. Lets the full pipeline + UI run end-to-end without live API access, and
powers QA (VG_MOCK_MODE=true). Real adapters (Phase C) return the same keys.
"""
from __future__ import annotations

import hashlib
from typing import Any

from lrs.providers.base import FetchContext


def _seed(ctx: FetchContext) -> float:
    """Stable float in [0,1) from PAN/phone — varies applicants deterministically."""
    key = (ctx.pan or ctx.phone or "seed").encode("utf-8")
    h = hashlib.sha256(key).hexdigest()
    return int(h[:8], 16) / 0xFFFFFFFF


def _pick(seed: float, options: list) -> Any:
    return options[int(seed * len(options)) % len(options)]


class MockBureauProvider:
    name = "bureau"
    pillar = "credit_bureau"

    async def fetch(self, ctx: FetchContext) -> dict[str, Any]:
        s = _seed(ctx)
        credit_score = int(640 + s * 250)  # 640..890
        return {
            "credit_score": credit_score,
            "on_time_payment_pct": round(85 + s * 15, 1),
            "credit_history_years": round(1 + s * 12, 1),
            "credit_utilization_pct": round(60 - s * 55, 1),
            "hard_inquiries_12m": int((1 - s) * 6),
            "public_record_type": "none",
            "active_loans_count": int((1 - s) * 4),
            "cc_utilization_pct": round(40 - s * 35, 1),
            "cibil_penalty_count": int((1 - s) * 2),
            "total_existing_emi": round((1 - s) * 20000, 2),
        }


class MockIncomeProvider:
    name = "income"
    pillar = "income"

    async def fetch(self, ctx: FetchContext) -> dict[str, Any]:
        s = _seed(ctx)
        # Prefer real form income; else synthesise.
        app = ctx.app or {}
        nmi = _to_float(app.get("monthly_net_income")) or _to_float(app.get("monthly_gross_income"))
        if not nmi:
            nmi = round(30000 + s * 120000, 2)
        return {
            "net_monthly_income": nmi,
            "annual_income": round(nmi * 12, 2),
            "employment_type": _pick(s, [
                "self_employed_irregular", "salaried_private_small",
                "salaried_private_mnc", "salaried_govt_psu",
            ]),
            "job_tenure_years": round(0.5 + s * 8, 1),
            "income_volatility_pct": round((1 - s) * 25, 1),
            "industry_risk_class": _pick(s, [
                "construction_tourism", "retail_manufacturing", "govt_health_it_banking",
            ]),
            "income_cv_pct": round((1 - s) * 18, 1),
        }


class MockBankStmtProvider:
    name = "bankstmt"
    pillar = "bank_statement"

    async def fetch(self, ctx: FetchContext) -> dict[str, Any]:
        s = _seed(ctx)
        return {
            "amb_pct_of_nmi": round(10 + s * 55, 1),
            "net_cash_flow": round((s - 0.3) * 40000, 2),
            "cash_flow_ratio": round(0.9 + s * 0.9, 2),
            "surplus_income_ratio": round(s * 40, 1),
            "volatility_index": round((1 - s) * 35, 1),
            "negative_flow_ratio": round((1 - s) * 0.4, 2),
            "fixed_expense_ratio": round(70 - s * 45, 1),
            "essential_spending_ratio": round(80 - s * 45, 1),
            "savings_ratio": round(s * 35, 1),
            "overdrafts_per_month": int((1 - s) * 3),
            "penalty_count": int((1 - s) * 3),
            "otp_ratio_pct": round(80 + s * 20, 1),
            "missed_payment_ratio": round((1 - s) * 0.15, 2),
            "emi_to_income_pct": round((1 - s) * 45, 1),
        }


class MockKycProvider:
    name = "kyc"
    pillar = "personal_profile"

    async def fetch(self, ctx: FetchContext) -> dict[str, Any]:
        s = _seed(ctx)
        return {
            "employer_reputation_class": _pick(s, [
                "contract_parttime", "sme", "large_corporate", "govt_psu",
            ]),
            "job_tenure_stability_pct": round(30 + s * 60, 1),
            "age_years": int(24 + s * 30),
            "education_class": _pick(s, [
                "highschool_or_below", "graduate_diploma", "postgraduate_professional",
            ]),
            "ownership_class": _pick(s, [
                "pg_hostel_temporary", "rented_short_term", "rented_long_term", "owned_no_mortgage",
            ]),
            "years_at_address": round(s * 6, 1),
            "housing_burden_pct": round(60 - s * 45, 1),
        }


def _to_float(v) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def get_mock_providers() -> list:
    return [
        MockBureauProvider(),
        MockIncomeProvider(),
        MockBankStmtProvider(),
        MockKycProvider(),
    ]
