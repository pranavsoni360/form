"""Regression tests for bugs found during LRS stress testing.

Each test pins a specific defect that a stress fuzz surfaced:
  1. non-numeric provider values crashed scoring (ValueError from float()),
  2. a zero-weight-but-enabled pillar as the only present pillar divided by zero,
  3. a thin-file applicant (no credit data) could auto-approve on a derived score,
  4. a negative existing-EMI could inflate repayment capacity.
"""
import copy

import pytest

from lrs import decision, engine, scorecard
from lrs.pillars import _to_number, score_node


# ── 1. Non-numeric / NaN / bool inputs are treated as absent, never crash ──────

def _credit_node():
    return scorecard.load_scorecard()["pillars"]["credit_bureau"]["parameters"]["credit_score"]


@pytest.mark.parametrize("bad", ["seven-fifty", "", "N/A", None, True, False, float("nan"), float("inf")])
def test_non_numeric_range_input_is_absent_not_crash(bad):
    r = score_node(_credit_node(), {"credit_score": bad})
    assert r.present is False and r.score is None


def test_to_number_coercions():
    assert _to_number("750") == 750.0
    assert _to_number(750) == 750.0
    assert _to_number("1,000") is None      # thousands separators not numeric
    assert _to_number(True) is None          # bool is not a score
    assert _to_number(float("nan")) is None


def test_engine_survives_all_non_numeric_inputs():
    r = engine.score({"credit_score": "high", "net_monthly_income": "lots"})
    assert 0.0 <= r.total_score <= 100.0
    assert r.incomplete is True


# ── 2. Zero-weight enabled pillar as the only present pillar: no ZeroDivision ──

def test_zero_weight_only_present_pillar_no_zero_division():
    cfg = copy.deepcopy(scorecard.load_scorecard())
    cfg["pillars"]["credit_bureau"]["weight"] = 0
    cfg["pillars"]["income"]["weight"] = 65      # enabled weights still sum to 100
    scorecard._validate_scorecard(cfg)            # config is legal
    # credit_score is disabled, so use an enabled credit_bureau input to make
    # the pillar present (on_time_payment_pct → payment_history param).
    r = engine.score({"on_time_payment_pct": 99}, config=cfg)  # only credit_bureau present
    assert 0.0 <= r.total_score <= 100.0
    assert r.effective_weights == {"credit_bureau": 100.0}


# ── 3. Thin-file guard: missing credit pillar must not auto-approve ────────────

def test_missing_credit_pillar_blocks_auto_approve():
    sc = scorecard.load_scorecard()
    d = decision.decide(
        100.0, requested_amount=50000, requested_tenure_months=24,
        net_monthly_income=50000, scorecard_cfg=sc,
        missing_pillars=["credit_bureau", "income", "banking_behaviour"],
    )
    assert d.decision == "refer"   # would have been "approve" without the guard


def test_full_data_high_score_still_approves():
    sc = scorecard.load_scorecard()
    d = decision.decide(
        95.0, requested_amount=50000, requested_tenure_months=24,
        net_monthly_income=90000, scorecard_cfg=sc, missing_pillars=[],
    )
    assert d.decision == "approve"  # guard must not over-trigger on complete files


# ── 4. Negative existing EMI cannot inflate capacity ───────────────────────────

def test_negative_existing_emi_clamped():
    sc = scorecard.load_scorecard()
    d_neg = decision.decide(
        90.0, requested_amount=200000, requested_tenure_months=24,
        net_monthly_income=50000, existing_emi=-100000, scorecard_cfg=sc,
    )
    d_zero = decision.decide(
        90.0, requested_amount=200000, requested_tenure_months=24,
        net_monthly_income=50000, existing_emi=0, scorecard_cfg=sc,
    )
    # A negative EMI must not buy MORE capacity than zero existing EMI.
    assert d_neg.capacity_amount == d_zero.capacity_amount
