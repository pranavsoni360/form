"""Tests for decision + pricing."""
import pytest

from lrs import decision


def test_emi_formula():
    # P=500000, roi=12%, n=60 → ~11122
    assert decision.emi(500000, 12, 60) == pytest.approx(11122.22, abs=1.0)
    # zero-interest edge
    assert decision.emi(120000, 0, 12) == pytest.approx(10000.0)


def test_principal_for_emi_is_inverse_of_emi():
    p = decision.principal_for_emi(11122.22, 12, 60)
    assert p == pytest.approx(500000, abs=50)


def test_high_score_approves_low_rate():
    r = decision.decide(
        88, product_key="personal_loan",
        requested_amount=500000, requested_tenure_months=60,
        net_monthly_income=120000, existing_emi=0,
    )
    assert r.decision == "approve"
    # base 11.0 + 0.0 premium for 85-100 band
    assert r.interest_rate == pytest.approx(11.0)
    assert r.risk_band == "Excellent"
    assert r.recommended_amount > 0
    assert r.recommended_emi > 0


def test_low_score_rejects_high_rate():
    r = decision.decide(
        30, product_key="personal_loan",
        requested_amount=500000, requested_tenure_months=60,
        net_monthly_income=120000, existing_emi=0,
    )
    assert r.decision == "reject"
    assert r.interest_rate == pytest.approx(19.0)  # 11 + 8 premium


def test_mid_score_refers():
    r = decision.decide(
        60, product_key="personal_loan",
        requested_amount=300000, requested_tenure_months=48,
        net_monthly_income=80000,
    )
    assert r.decision == "refer"


def test_capacity_caps_recommended_amount():
    # Low income → capacity < requested → recommended capped below request.
    r = decision.decide(
        90, product_key="personal_loan",
        requested_amount=2000000, requested_tenure_months=60,
        net_monthly_income=40000, existing_emi=5000,
    )
    assert r.recommended_amount <= r.capacity_amount + 0.01
    assert r.recommended_amount < 2000000
    # Recommended EMI must be within the FOIR affordable EMI.
    assert r.recommended_emi <= r.max_affordable_emi + 1


def test_tenure_clamped_to_product_max():
    r = decision.decide(
        80, product_key="personal_loan",
        requested_amount=300000, requested_tenure_months=120,  # over 60 max
        net_monthly_income=100000,
    )
    assert r.recommended_tenure_m == 60
