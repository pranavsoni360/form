"""Tests for LRS explainability (reasons)."""
from lrs import engine, explain
from lrs.tests.test_engine import GOOD_INPUTS


def test_reasons_for_strong_applicant():
    r = engine.score(GOOD_INPUTS)
    reasons = explain.build_reasons(r.pillar_scores, "approve", r.rating, r.total_score)
    assert reasons["summary"].startswith("Approve")
    assert len(reasons["positives"]) >= 1
    # each factor has a human title + score
    for p in reasons["positives"]:
        assert p["factor"] and p["score"] is not None and p["weight"] > 0
    # strong applicant → few/no negatives
    assert len(reasons["negatives"]) <= 3


def test_reasons_surface_weaknesses():
    weak = dict(GOOD_INPUTS)
    weak.update({
        "credit_score": 610, "credit_utilization_pct": 85, "dti_pct": 65,
        "penalty_count": 5, "new_loan_emi_to_income_pct": 60,
    })
    r = engine.score(weak)
    reasons = explain.build_reasons(r.pillar_scores, "refer", r.rating, r.total_score)
    assert len(reasons["negatives"]) >= 1
    factors = " ".join(n["factor"] for n in reasons["negatives"]).lower()
    # a high-weight weakness (credit score / DTI / affordability) should show up
    assert any(w in factors for w in ["credit", "debt", "afford", "utiliz"])


def test_positive_factors_ranked_by_weight():
    r = engine.score(GOOD_INPUTS)
    reasons = explain.build_reasons(r.pillar_scores, "approve", r.rating, r.total_score)
    weights = [p["weight"] for p in reasons["positives"]]
    assert weights == sorted(weights, reverse=True)
