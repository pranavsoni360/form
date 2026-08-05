"""Finance-grade rigorous tests — invariants that MUST hold for real lending.

These go beyond unit logic: completeness (no silently-dropped parameter),
golden full-total (all pillars), band integrity, bounds under fuzzing,
monotonicity, and decision safety invariants.
"""
import asyncio
import random

import pytest

from lrs import decision, engine, normalize, scorecard, service
from lrs.tests.test_engine import GOOD_INPUTS


def _run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# Config walkers
# ---------------------------------------------------------------------------

def _walk_leaves(node):
    """Yield (input_key, node) for every leaf (range/category) under a node."""
    t = node.get("type")
    if t == "composite":
        for child in node["children"].values():
            yield from _walk_leaves(child)
    else:
        yield node["input_key"], node


def _all_leaves():
    cfg = scorecard.load_scorecard()
    out = []
    for pillar in cfg["pillars"].values():
        for param in pillar["parameters"].values():
            out.extend(_walk_leaves(param))
    return out


# ---------------------------------------------------------------------------
# 1. COMPLETENESS — a full applicant must have NO missing leaf
#    (a silently-absent leaf would re-weight and distort the score)
# ---------------------------------------------------------------------------

def _assert_all_present(node, path=""):
    if node.get("children"):
        for name, c in node["children"].items():
            _assert_all_present(c, f"{path}.{name}")
    else:
        assert node.get("present") is True, f"leaf not present: {path}"


def test_full_applicant_has_no_missing_leaf():
    """Mock pipeline for a complete applicant must populate EVERY config leaf."""
    app = {
        "id": "1", "pan_number": "ABCDE1234F", "phone": "9876543210",
        "loan_amount_requested": 150000, "monthly_net_income": 60000,
        "monthly_gross_income": 70000, "monthly_emi_existing": 8000,
        "repayment_period_years": 2, "purpose_of_loan": "personal loan",
    }
    r = _run(service.score_application(app))
    assert r["incomplete"] is False, f"missing pillars: {r['missing_pillars']}"
    for pillar in r["pillar_scores"].values():
        _assert_all_present(pillar)


def test_every_config_input_key_is_producible():
    """Cross-check: every leaf input_key is supplied by mock providers+normalize."""
    app = {
        "id": "1", "pan_number": "ABCDE1234F", "phone": "9",
        "loan_amount_requested": 150000, "monthly_net_income": 50000,
        "monthly_emi_existing": 5000, "repayment_period_years": 2,
        "purpose_of_loan": "personal",
    }
    from lrs.providers.base import FetchContext
    from lrs.providers.mock import get_mock_providers
    ctx = FetchContext(pan="ABCDE1234F", aadhaar=None, phone="9", app=app)
    payloads = [_run(p.fetch(ctx)) for p in get_mock_providers()]
    inputs = normalize.to_canonical_inputs(app, payloads)
    missing = [k for k, _ in _all_leaves() if inputs.get(k) is None]
    assert missing == [], f"input_keys with no data source: {missing}"


# ---------------------------------------------------------------------------
# 2. GOLDEN full total — all 4 pillars hand-computed
# ---------------------------------------------------------------------------

def test_golden_full_total():
    r = engine.score(GOOD_INPUTS)
    # credit_score disabled → credit_bureau rescales to 95.29 over weight 17.
    # Credit 95.29*35 + Income 99.2*30 + Banking 100*20 + Profile 96.2*15 = 97.54
    assert r.pillar_scores["credit_bureau"]["score"] == pytest.approx(95.29, abs=0.02)
    assert r.pillar_scores["income"]["score"] == pytest.approx(99.2, abs=0.05)
    assert r.pillar_scores["banking_behaviour"]["score"] == pytest.approx(100.0, abs=0.02)
    assert r.pillar_scores["personal_profile"]["score"] == pytest.approx(96.2, abs=0.05)
    assert r.total_score == pytest.approx(97.54, abs=0.1)


def test_rollup_self_consistency():
    """total == Σ(pillar_score × effective_weight)/100 exactly."""
    r = engine.score(GOOD_INPUTS)
    recomputed = sum(
        r.pillar_scores[k]["score"] * w / 100 for k, w in r.effective_weights.items()
    )
    assert r.total_score == pytest.approx(recomputed, abs=0.01)


# ---------------------------------------------------------------------------
# 3. BAND INTEGRITY — no overlapping bands (ambiguous scoring)
# ---------------------------------------------------------------------------

def test_no_overlapping_bands():
    for key, node in _all_leaves():
        if node["type"] != "range":
            continue
        bands = sorted(node["bands"], key=lambda b: float(b["from"]))
        for i in range(1, len(bands)):
            assert float(bands[i]["from"]) > float(bands[i - 1]["to"]), \
                f"overlapping bands in {key}: {bands[i-1]} vs {bands[i]}"


def test_scores_within_0_100_in_config():
    for key, node in _all_leaves():
        entries = node.get("bands") or list(node.get("categories", {}).values())
        for e in entries:
            assert 0 <= float(e["score"]) <= 100, f"{key}: score out of range {e}"


# ---------------------------------------------------------------------------
# 4. BOUNDS FUZZ — random applicants never break the 0-100 invariant / crash
# ---------------------------------------------------------------------------

def _random_inputs(rng):
    inputs = {}
    for key, node in _all_leaves():
        if rng.random() < 0.1:
            continue  # sometimes omit → exercises re-weighting
        if node["type"] == "category":
            keys = [k for k in node["categories"] if k != "__default__"]
            inputs[key] = rng.choice(keys + ["some_unknown_value"])
        else:
            lo = float(node["bands"][0]["from"])
            hi = float(node["bands"][-1]["to"])
            lo = max(lo, -1000); hi = min(hi, 2_000_000)
            inputs[key] = round(rng.uniform(lo, hi), 2)
    return inputs


def test_score_bounds_under_fuzz():
    rng = random.Random(42)
    for _ in range(1000):
        r = engine.score(_random_inputs(rng))
        assert 0.0 <= r.total_score <= 100.0
        assert r.total_score == r.total_score  # not NaN
        for p in r.pillar_scores.values():
            if p.get("present") and p.get("score") is not None:
                assert 0.0 <= p["score"] <= 100.0


# ---------------------------------------------------------------------------
# 5. MONOTONICITY — better inputs never lower, worse inputs never raise
# ---------------------------------------------------------------------------

def _score_with(**overrides):
    inp = dict(GOOD_INPUTS); inp.update(overrides)
    return engine.score(inp).total_score


@pytest.mark.parametrize("key,values", [
    ("credit_score", [300, 500, 660, 720, 780, 850]),
    ("net_monthly_income", [10000, 20000, 35000, 55000, 90000]),
    ("otp_ratio_pct", [60, 82, 92, 98]),
    ("job_tenure_years", [0.5, 2, 4, 8]),
    ("amb_pct_of_nmi", [5, 15, 25, 40, 60]),
])
def test_higher_is_better_params_monotonic_up(key, values):
    scores = [_score_with(**{key: v}) for v in values]
    assert scores == sorted(scores), f"{key} not monotonic-up: {scores}"


@pytest.mark.parametrize("key,values", [
    ("credit_utilization_pct", [5, 25, 45, 65, 90]),
    ("hard_inquiries_12m", [0, 2, 5, 9]),
    ("dti_pct", [10, 25, 45, 70]),
    ("new_loan_emi_to_income_pct", [10, 20, 30, 45, 60]),
    ("penalty_count", [0, 1, 3, 6]),
    ("income_volatility_pct", [5, 15, 30]),
])
def test_higher_is_worse_params_monotonic_down(key, values):
    scores = [_score_with(**{key: v}) for v in values]
    assert scores == sorted(scores, reverse=True), f"{key} not monotonic-down: {scores}"


# ---------------------------------------------------------------------------
# 6. DECISION SAFETY INVARIANTS (fuzz)
# ---------------------------------------------------------------------------

def test_decision_invariants_under_fuzz():
    rng = random.Random(7)
    rc = scorecard.load_risk_premium()
    for _ in range(1000):
        score = round(rng.uniform(0, 100), 2)
        product = rng.choice(["personal_loan", "consumer_loan"])
        requested = round(rng.uniform(0, 500000), 2)
        tenure = rng.choice([0, 6, 12, 24, 36, 120])
        income = round(rng.uniform(0, 150000), 2)
        existing = round(rng.uniform(0, 60000), 2)
        d = decision.decide(
            score, product_key=product, requested_amount=requested,
            requested_tenure_months=tenure, net_monthly_income=income, existing_emi=existing,
        )
        p = rc["products"][product]
        # never exceed the product cap, the requested amount, or the FOIR capacity
        assert d.recommended_amount <= p["max_amount"] + 0.01
        assert d.recommended_amount <= max(requested, 0) + 0.01
        assert d.recommended_amount <= d.capacity_amount + 0.01
        # the recommended EMI must fit inside the affordable (FOIR) EMI
        assert d.recommended_emi <= d.max_affordable_emi + 1.0
        # tenure never exceeds product max
        assert d.recommended_tenure_m <= p["max_tenure_months"]
        # rate is base + a non-negative premium
        assert d.interest_rate >= p["base_roi"] - 0.001
        # decision matches thresholds
        th = scorecard.load_scorecard()["decision_thresholds"]
        expected = "approve" if score >= th["approve"] else "refer" if score >= th["refer"] else "reject"
        # capacity too low can downgrade approve→refer (documented behaviour)
        assert d.decision in (expected, "refer")


def test_worse_score_never_cheaper():
    """ROI must be monotonic non-increasing as score improves."""
    rates = [
        decision.decide(s, product_key="personal_loan", requested_amount=100000,
                        requested_tenure_months=24, net_monthly_income=60000).interest_rate
        for s in [10, 30, 45, 60, 75, 90]
    ]
    assert rates == sorted(rates, reverse=True), rates
