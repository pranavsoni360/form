"""Scoring engine — roll pillar parameters up to a final weighted score.

Consumes canonical `inputs` (a flat dict of the fields named by each node's
`input_key`) and the scorecard config, and produces the final 0-100 score plus
a full transparency breakdown.

Re-weighting: parameter weights are absolute (share of the total 100). If a
whole pillar's data is absent, that pillar is dropped and the remaining pillar
weights are renormalised to 100 — so the score stays on a 0-100 scale and
`incomplete` is flagged. Partially-available pillars still score (their present
parameters are renormalised inside `pillars.score_node`).
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field

from lrs import scorecard
from lrs.pillars import NodeResult, score_node, _weighted_average


@dataclass
class EngineResult:
    total_score: float
    rating: str
    pillar_scores: dict = field(default_factory=dict)   # JSON-ready breakdown
    effective_weights: dict = field(default_factory=dict)
    missing_pillars: list[str] = field(default_factory=list)
    incomplete: bool = False
    config_version: str = ""


# Rating bands for the FINAL score (display only; pricing uses risk_premium).
_RATING_BANDS = [
    (85, "Excellent"), (70, "Very Good"), (55, "Good"), (40, "Fair"), (0, "Poor"),
]


def _rating_for(score: float) -> str:
    for lo, label in _RATING_BANDS:
        if score >= lo:
            return label
    return "Poor"


def _node_to_dict(name: str, r: NodeResult) -> dict:
    d = {
        "present": r.present,
        "score": round(r.score, 2) if r.score is not None else None,
        "weight": r.weight,
    }
    if r.raw_value is not None:
        d["value"] = r.raw_value
    if r.rating:
        d["rating"] = r.rating
    if r.approval:
        d["approval"] = r.approval
    if r.children:
        d["children"] = {n: _node_to_dict(n, c) for n, c in r.children.items()}
    return d


def _rescale_children(node: dict) -> None:
    """Drop disabled composite children and rescale the enabled siblings so their
    relative weights are preserved. Recurses into nested composites."""
    if node.get("type") != "composite":
        return
    children = node.get("children", {})
    active = {k: c for k, c in children.items() if c.get("enabled", True)}
    node["children"] = active
    total = sum(float(c["weight"]) for c in active.values())
    if total > 0:
        # Renormalise children to sum to 100 (composite weights are relative,
        # % of the composite — matches the file convention).
        scale = 100.0 / total
        for c in active.values():
            c["weight"] = round(float(c["weight"]) * scale, 6)
    for c in active.values():
        _rescale_children(c)


def _prepare_config(cfg: dict) -> dict:
    """Return a scoring-ready config with disabled pillars/parameters/sub-params
    removed and the remaining weights rescaled proportionally at every level:
      - disabled pillars dropped, remaining pillars rescaled to sum 100
      - disabled parameters dropped, remaining rescaled to the pillar weight
      - disabled composite children dropped, remaining rescaled to sum 100
    Weights are RELATIVE at every level, so any enable/disable or re-weight
    proportionally rebalances the siblings."""
    cfg = copy.deepcopy(cfg)

    # 1. Pillars: drop disabled, rescale the rest to sum 100.
    pillars = {k: p for k, p in cfg["pillars"].items() if p.get("enabled", True)}
    pillar_total = sum(float(p["weight"]) for p in pillars.values())
    if pillar_total > 0:
        pscale = 100.0 / pillar_total
        for p in pillars.values():
            p["weight"] = round(float(p["weight"]) * pscale, 6)
    cfg["pillars"] = pillars

    # 2. Parameters + 3. composite children.
    for pillar in pillars.values():
        params = {k: v for k, v in pillar["parameters"].items() if v.get("enabled", True)}
        if not params:
            pillar["parameters"] = {}
            continue
        pillar_w = float(pillar["weight"])
        active_w = sum(float(p["weight"]) for p in params.values())
        if active_w > 0:
            scale = pillar_w / active_w
            for p in params.values():
                p["weight"] = round(float(p["weight"]) * scale, 6)
        for p in params.values():
            _rescale_children(p)
        pillar["parameters"] = params
    return cfg


def score(inputs: dict, config: dict | None = None) -> EngineResult:
    """Compute the final LRS score from canonical inputs."""
    raw_cfg = config or scorecard.load_scorecard()
    cfg = _prepare_config(raw_cfg)
    pillars = cfg["pillars"]

    pillar_results: dict[str, NodeResult] = {}
    breakdown: dict = {}
    missing: list[str] = []

    for pkey, pillar in pillars.items():
        params = {
            name: score_node(node, inputs)
            for name, node in pillar["parameters"].items()
        }
        present = {n: r for n, r in params.items() if r.present}
        pweight = float(pillar["weight"])
        if not present:
            missing.append(pkey)
            pillar_results[pkey] = NodeResult(present=False, weight=pweight, children=params)
        else:
            pscore = _weighted_average(present)
            pillar_results[pkey] = NodeResult(
                present=True, score=pscore, weight=pweight, children=params
            )
        breakdown[pkey] = {
            "title": pillar.get("title", pkey),
            **_node_to_dict(pkey, pillar_results[pkey]),
        }

    present_pillars = {k: r for k, r in pillar_results.items() if r.present}
    if not present_pillars:
        # No data at all — zero score, everything missing.
        return EngineResult(
            total_score=0.0, rating="Poor", pillar_scores=breakdown,
            effective_weights={}, missing_pillars=missing, incomplete=True,
            config_version=cfg.get("config_version", ""),
        )

    total = _weighted_average(present_pillars)
    total_present_w = sum(r.weight for r in present_pillars.values())
    if total_present_w > 0:
        effective = {
            k: round(r.weight / total_present_w * 100, 2)
            for k, r in present_pillars.items()
        }
    else:
        # All present pillars carry zero configured weight (a bank can set a
        # pillar weight to 0 yet leave it enabled). Fall back to equal effective
        # weights so we never divide by zero.
        n = len(present_pillars)
        effective = {k: round(100.0 / n, 2) for k in present_pillars}
    # Annotate the breakdown with effective (re-weighted) pillar weights.
    for k in present_pillars:
        breakdown[k]["effective_weight"] = effective[k]

    return EngineResult(
        total_score=round(total, 2),
        rating=_rating_for(total),
        pillar_scores=breakdown,
        effective_weights=effective,
        missing_pillars=missing,
        incomplete=bool(missing),
        config_version=cfg.get("config_version", ""),
    )
