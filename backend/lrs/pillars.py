"""Pure scoring calculators — map canonical inputs to 0-100 scores via config.

`score_node` recursively evaluates a scorecard node:
  - range     : numeric band lookup (inclusive from..to)
  - category  : exact-match map (falls back to __default__ for unknown values)
  - composite : weighted average of present children (weights renormalised)

A node is "absent" when its input value is missing (None / not supplied). Absent
nodes are excluded from their parent's weighted average, and the remaining
siblings are renormalised — so a partially-available pillar still scores. This
mirrors the reference `fn_lrs_*` value/score functions but keeps the math pure
and testable (no DB).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class NodeResult:
    present: bool
    score: Optional[float] = None          # 0-100, None if absent
    raw_value: Any = None                  # the input value (for display)
    rating: Optional[str] = None
    approval: Optional[str] = None
    weight: float = 0.0                    # this node's configured weight
    children: dict[str, "NodeResult"] = field(default_factory=dict)


def _match_band(value: float, bands: list[dict]) -> dict:
    """Return the band whose [from,to] contains value; if none, the nearest band."""
    for b in bands:
        if float(b["from"]) <= value <= float(b["to"]):
            return b
    # Out of range → clamp to the nearest band by boundary distance.
    def dist(b: dict) -> float:
        lo, hi = float(b["from"]), float(b["to"])
        if value < lo:
            return lo - value
        return value - hi
    return min(bands, key=dist)


def score_node(node: dict, inputs: dict) -> NodeResult:
    """Evaluate one scorecard node against canonical inputs."""
    ntype = node["type"]
    weight = float(node.get("weight", 0.0))

    if ntype == "range":
        val = inputs.get(node["input_key"])
        if val is None:
            return NodeResult(present=False, weight=weight)
        val = float(val)
        band = _match_band(val, node["bands"])
        return NodeResult(
            present=True, score=float(band["score"]), raw_value=val,
            rating=band.get("rating"), approval=band.get("approval"), weight=weight,
        )

    if ntype == "category":
        val = inputs.get(node["input_key"])
        if val is None:
            return NodeResult(present=False, weight=weight)
        cats = node["categories"]
        entry = cats.get(str(val), cats["__default__"])
        return NodeResult(
            present=True, score=float(entry["score"]), raw_value=val,
            rating=entry.get("rating"), approval=entry.get("approval"), weight=weight,
        )

    if ntype == "composite":
        child_results: dict[str, NodeResult] = {}
        for name, child in node["children"].items():
            child_results[name] = score_node(child, inputs)
        present = {n: r for n, r in child_results.items() if r.present}
        if not present:
            return NodeResult(present=False, weight=weight, children=child_results)
        score = _weighted_average(present)
        return NodeResult(
            present=True, score=score, weight=weight, children=child_results,
        )

    raise ValueError(f"unknown node type {ntype!r}")


def _weighted_average(present: dict[str, NodeResult]) -> float:
    """Weighted average of present results, renormalising their weights."""
    total_w = sum(r.weight for r in present.values())
    if total_w <= 0:
        # No usable weights — fall back to a plain mean.
        return sum(r.score for r in present.values()) / len(present)
    return sum(r.score * r.weight for r in present.values()) / total_w
