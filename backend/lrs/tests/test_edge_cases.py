"""In-depth edge-case + integration tests for the LRS core."""
import pytest

from lrs import decision, engine, scorecard
from lrs.pillars import score_node
from lrs.tests.test_engine import GOOD_INPUTS


# ---------- band boundary correctness ----------

def _credit_node():
    return scorecard.load_scorecard()["pillars"]["credit_bureau"]["parameters"]["credit_score"]


@pytest.mark.parametrize("value,expected", [
    (900, 100), (800, 100),           # top band inclusive both ends
    (799, 80), (750, 80),             # second band inclusive
    (749, 60), (700, 60),             # third band
    (699, 40), (650, 40),
    (649, 20), (300, 20),
])
def test_credit_score_band_boundaries(value, expected):
    assert score_node(_credit_node(), {"credit_score": value}).score == expected


def test_out_of_range_clamps_not_crashes():
    node = _credit_node()
    assert score_node(node, {"credit_score": 1200}).score == 100   # above max
    assert score_node(node, {"credit_score": 100}).score == 20     # below min
    assert score_node(node, {"credit_score": 749.4}).score in (60, 80)  # gap → nearest


# ---------- invariants ----------

@pytest.mark.parametrize("cs", [300, 500, 650, 720, 780, 850])
def test_total_score_always_in_range(cs):
    inp = dict(GOOD_INPUTS)
    inp["credit_score"] = cs
    r = engine.score(inp)
    assert 0.0 <= r.total_score <= 100.0


def test_credit_score_monotonic_on_pillar():
    prev = -1
    for cs in [300, 660, 710, 760, 810]:
        inp = dict(GOOD_INPUTS); inp["credit_score"] = cs
        s = engine.score(inp).pillar_scores["credit_bureau"]["score"]
        assert s >= prev
        prev = s


def test_partial_pillar_still_scores_and_not_flagged_missing():
    """Drop some (not all) credit_bureau leaves → pillar present, not in missing."""
    inp = dict(GOOD_INPUTS)
    for k in ["on_time_payment_pct", "credit_history_years", "hard_inquiries_12m"]:
        inp.pop(k)
    r = engine.score(inp)
    assert "credit_bureau" not in r.missing_pillars
    assert r.pillar_scores["credit_bureau"]["present"] is True
    assert r.pillar_scores["credit_bureau"]["score"] is not None


def test_effective_weights_reweight_when_two_pillars_missing():
    inp = {k: v for k, v in GOOD_INPUTS.items()}
    # Drop bank_statement + loan_specific entirely.
    drop = [k for k in inp if k in (
        "amb_pct_of_nmi","net_cash_flow","cash_flow_ratio","surplus_income_ratio",
        "volatility_index","negative_flow_ratio","fixed_expense_ratio",
        "essential_spending_ratio","savings_ratio","overdrafts_per_month","penalty_count",
        "otp_ratio_pct","missed_payment_ratio","emi_to_income_pct","cibil_penalty_count",
        "loan_purpose","secured_unsecured","income_generating","essential_discretionary",
        "loan_amount_to_annual_income_x","tenure_years","ltv_pct")]
    for k in drop:
        inp.pop(k)
    r = engine.score(inp)
    assert set(r.missing_pillars) == {"bank_statement", "loan_specific"}
    # credit(30)+income(30)+profile(10) = 70 → renormalize to 100
    assert sum(r.effective_weights.values()) == pytest.approx(100, abs=0.05)
    assert r.effective_weights["credit_bureau"] == pytest.approx(30/70*100, abs=0.05)


# ---------- decision edge cases ----------

def test_zero_income_no_capacity():
    r = decision.decide(90, product_key="personal_loan", requested_amount=300000,
                        requested_tenure_months=48, net_monthly_income=0)
    assert r.capacity_amount == 0
    assert r.recommended_amount == 0
    assert r.decision == "refer"   # risk ok but capacity too low → refer


def test_existing_emi_exceeds_income():
    r = decision.decide(85, product_key="personal_loan", requested_amount=300000,
                        requested_tenure_months=48, net_monthly_income=50000,
                        existing_emi=60000)
    assert r.max_affordable_emi == 0
    assert r.recommended_amount == 0


def test_unknown_product_falls_back_to_default():
    r = decision.decide(80, product_key="does_not_exist", requested_amount=100000,
                        requested_tenure_months=24, net_monthly_income=80000)
    assert r.interest_rate > 0  # used default product, produced an offer


def test_recommended_emi_never_exceeds_foir():
    for score in (45, 60, 75, 92):
        r = decision.decide(score, product_key="consumer_loan", requested_amount=800000,
                            requested_tenure_months=36, net_monthly_income=60000,
                            existing_emi=8000)
        assert r.recommended_emi <= r.max_affordable_emi + 1.0


# ---------- full integration: engine → decision ----------

def test_end_to_end_good_applicant():
    r = engine.score(GOOD_INPUTS)
    d = decision.decide(
        r.total_score, product_key="personal_loan",
        requested_amount=800000, requested_tenure_months=60,
        net_monthly_income=GOOD_INPUTS["net_monthly_income"],
        existing_emi=0,
    )
    assert d.decision == "approve"
    assert d.recommended_amount > 0
    assert d.recommended_emi > 0
    assert 11.0 <= d.interest_rate <= 13.0
