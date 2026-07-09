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
        "credit_bureau": 35,
        "income": 30,
        "banking_behaviour": 20,
        "personal_profile": 15,
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


def test_config_version_fits_db_column():
    """lrs_scores.config_version is VARCHAR(20) — keep versions short."""
    assert len(scorecard.config_version()) <= 20
    assert len(scorecard.load_risk_premium()["config_version"]) <= 20


def test_risk_premium_loads_and_covers_range():
    cfg = scorecard.load_risk_premium()
    assert "personal_loan" in cfg["products"]
    assert "consumer_loan" in cfg["products"]


def test_bad_pillar_weights_rejected():
    cfg = copy.deepcopy(scorecard.load_scorecard())
    cfg["pillars"]["credit_bureau"]["weight"] = 40  # breaks the sum
    with pytest.raises(scorecard.ScorecardConfigError):
        scorecard._validate_scorecard(cfg)


def test_composite_children_are_relative_no_sum_constraint():
    # Composite child weights are RELATIVE now — an arbitrary weight is fine as
    # long as at least one enabled child has weight > 0 (engine rescales to 100).
    cfg = copy.deepcopy(scorecard.load_scorecard())
    kids = cfg["pillars"]["income"]["parameters"]["income_stability"]["children"]
    first = next(iter(kids))
    kids[first]["weight"] = 999
    scorecard._validate_scorecard(cfg)  # must NOT raise


def test_composite_all_children_disabled_rejected():
    cfg = copy.deepcopy(scorecard.load_scorecard())
    kids = cfg["pillars"]["income"]["parameters"]["income_stability"]["children"]
    for c in kids.values():
        c["enabled"] = False
    with pytest.raises(scorecard.ScorecardConfigError):
        scorecard._validate_scorecard(cfg)


def test_disabled_pillar_excluded_from_100_sum():
    # Disabling a pillar drops it from the enabled-total; the remaining enabled
    # pillars must still sum to 100 (else rejected).
    cfg = copy.deepcopy(scorecard.load_scorecard())
    cfg["pillars"]["personal_profile"]["enabled"] = False  # weight 15 removed
    with pytest.raises(scorecard.ScorecardConfigError):
        scorecard._validate_scorecard(cfg)  # now enabled total = 85 ≠ 100
    # Re-home that 15 onto credit_bureau → enabled total back to 100.
    cfg["pillars"]["credit_bureau"]["weight"] += 15
    scorecard._validate_scorecard(cfg)  # must NOT raise
