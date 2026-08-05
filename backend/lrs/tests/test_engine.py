"""Tests for the LRS scoring engine + pillar calculators (lean 4-pillar model)."""
import pytest

from lrs import engine
from lrs.pillars import score_node


# A well-qualified applicant with every canonical field present.
GOOD_INPUTS = {
    # credit_bureau
    "credit_score": 780, "on_time_payment_pct": 99, "credit_utilization_pct": 15,
    "hard_inquiries_12m": 1, "credit_history_years": 8, "public_record_type": "none",
    # income & affordability
    "net_monthly_income": 70000, "employment_type": "salaried_private_mnc",
    "job_tenure_years": 6, "income_volatility_pct": 5,
    "industry_risk_class": "govt_health_it_banking", "new_loan_emi_to_income_pct": 12,
    # banking behaviour
    "amb_pct_of_nmi": 60, "otp_ratio_pct": 98, "missed_payment_ratio": 0,
    "penalty_count": 0, "net_cash_flow": 25000, "surplus_income_ratio": 35,
    # profile
    "employer_reputation_class": "mnc", "job_tenure_stability_pct": 60, "income_cv_pct": 1,
    "age_years": 34, "education_class": "postgraduate_professional",
    "ownership_class": "owned_no_mortgage", "years_at_address": 5, "housing_burden_pct": 20,
    "total_emi_pct_income": 15, "active_loans_count": 1, "cc_utilization_pct": 8, "dti_pct": 20,
}


def test_credit_bureau_pillar_exact_math():
    """credit_score is disabled (VG returns no bureau score), so the remaining
    params rescale over weight 17: (100*7 + 80*4 + 100*3 + 100*2 + 100*1)/17 = 95.29"""
    r = engine.score(GOOD_INPUTS)
    assert r.pillar_scores["credit_bureau"]["score"] == pytest.approx(95.29, abs=0.02)


def test_full_applicant_scores_high_and_complete():
    r = engine.score(GOOD_INPUTS)
    assert 70 <= r.total_score <= 100
    assert r.incomplete is False
    assert r.missing_pillars == []
    assert set(r.pillar_scores.keys()) == {
        "credit_bureau", "income", "banking_behaviour", "personal_profile",
    }
    assert sum(r.effective_weights.values()) == pytest.approx(100, abs=0.05)
    assert r.rating in ("Excellent", "Very Good")


def test_range_band_lookup():
    node = {"type": "range", "weight": 1, "input_key": "credit_score", "bands": [
        {"from": 800, "to": 900, "score": 100},
        {"from": 750, "to": 799, "score": 80},
        {"from": 300, "to": 749, "score": 20},
    ]}
    assert score_node(node, {"credit_score": 820}).score == 100
    assert score_node(node, {"credit_score": 780}).score == 80
    assert score_node(node, {"credit_score": 500}).score == 20
    assert score_node(node, {"credit_score": 950}).score == 100  # clamps
    assert score_node(node, {}).present is False


def test_category_default_fallback():
    node = {"type": "category", "weight": 1, "input_key": "x", "categories": {
        "a": {"score": 100}, "__default__": {"score": 50},
    }}
    assert score_node(node, {"x": "a"}).score == 100
    assert score_node(node, {"x": "unknown_value"}).score == 50
    assert score_node(node, {}).present is False


def test_composite_renormalizes_present_children():
    node = {"type": "composite", "weight": 1, "children": {
        "a": {"type": "range", "weight": 50, "input_key": "a",
              "bands": [{"from": 0, "to": 100, "score": 80}]},
        "b": {"type": "range", "weight": 50, "input_key": "b",
              "bands": [{"from": 0, "to": 100, "score": 40}]},
    }}
    assert score_node(node, {"a": 1, "b": 1}).score == pytest.approx(60)
    assert score_node(node, {"a": 1}).score == pytest.approx(80)  # renormalize


def test_missing_pillar_reweights_to_100():
    inputs = {k: v for k, v in GOOD_INPUTS.items()}
    # Drop ALL banking_behaviour fields.
    for k in ["amb_pct_of_nmi", "otp_ratio_pct", "missed_payment_ratio",
              "penalty_count", "net_cash_flow", "surplus_income_ratio"]:
        inputs.pop(k, None)
    r = engine.score(inputs)
    assert "banking_behaviour" in r.missing_pillars
    assert r.incomplete is True
    assert sum(r.effective_weights.values()) == pytest.approx(100, abs=0.05)
    assert "banking_behaviour" not in r.effective_weights
    # credit_bureau effective weight = 35/(35+30+15)*100 = 43.75
    assert r.effective_weights["credit_bureau"] == pytest.approx(43.75, abs=0.05)
    assert 0 <= r.total_score <= 100


def test_no_data_returns_zero_incomplete():
    r = engine.score({})
    assert r.total_score == 0.0
    assert r.incomplete is True
    assert len(r.missing_pillars) == 4
