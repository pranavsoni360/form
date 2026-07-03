"""Tests for the scorecard config loader + validator."""
import copy

import pytest

from lrs import scorecard


def test_scorecard_loads_and_validates():
    cfg = scorecard.load_scorecard()
    assert cfg["pillars"]
    # Pillar weights sum to 100.
    total = sum(p["weight"] for p in cfg["pillars"].values())
    assert abs(total - 100) <= 0.01


def test_expected_pillars_and_weights():
    cfg = scorecard.load_scorecard()
    expected = {
        "credit_bureau": 30,
        "income": 30,
        "bank_statement": 20,
        "personal_profile": 10,
        "loan_specific": 10,
    }
    got = {k: v["weight"] for k, v in cfg["pillars"].items()}
    assert got == expected


def test_each_pillar_parameter_weights_sum_to_pillar_weight():
    """Parameter weights are absolute (share of total 100), so within a pillar
    they sum to that pillar's weight."""
    cfg = scorecard.load_scorecard()
    for pkey, pillar in cfg["pillars"].items():
        s = sum(n["weight"] for n in pillar["parameters"].values())
        assert abs(s - pillar["weight"]) <= 0.01, f"{pkey} params sum {s}"


def test_composite_children_weights_sum_100():
    cfg = scorecard.load_scorecard()
    for pkey, pillar in cfg["pillars"].items():
        for name, node in pillar["parameters"].items():
            if node.get("type") == "composite":
                s = sum(c["weight"] for c in node["children"].values())
                assert abs(s - 100) <= 0.01, f"{pkey}.{name} children sum {s}"


def test_risk_premium_loads_and_covers_range():
    cfg = scorecard.load_risk_premium()
    assert "personal_loan" in cfg["products"]
    assert "consumer_loan" in cfg["products"]


def test_bad_pillar_weights_rejected():
    cfg = copy.deepcopy(scorecard.load_scorecard())
    cfg["pillars"]["credit_bureau"]["weight"] = 40  # breaks the sum
    with pytest.raises(scorecard.ScorecardConfigError):
        scorecard._validate_scorecard(cfg)


def test_bad_composite_children_rejected():
    cfg = copy.deepcopy(scorecard.load_scorecard())
    # Corrupt one composite child weight.
    kids = cfg["pillars"]["income"]["parameters"]["income_stability"]["children"]
    first = next(iter(kids))
    kids[first]["weight"] = 999
    with pytest.raises(scorecard.ScorecardConfigError):
        scorecard._validate_scorecard(cfg)
