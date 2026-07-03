"""Explainability — turn the score breakdown into plain-language reasons.

Surfaces the top factors that HELPED and HURT the score (weighted by how much
each contributes to the total), plus a one-line summary. Lets a loan officer
see *why* an applicant got their score, not just the number.
"""
from __future__ import annotations

from lrs import scorecard


def _title_map() -> dict[str, str]:
    cfg = scorecard.load_scorecard()
    m: dict[str, str] = {}
    for pillar in cfg["pillars"].values():
        for pk, param in pillar["parameters"].items():
            m[pk] = param.get("title", pk)
            for ck, child in (param.get("children") or {}).items():
                m[ck] = child.get("title", ck)
    return m


def _leaf(key: str, node: dict, global_weight: float, titles: dict) -> dict:
    return {
        "factor": titles.get(key, key),
        "value": node.get("value"),
        "rating": node.get("rating"),
        "score": node.get("score"),
        "weight": round(global_weight, 2),  # % of the total 100 this factor carries
    }


def _collect_leaves(pillar_scores: dict, titles: dict) -> list[dict]:
    """Flatten present leaves with their GLOBAL weight (share of the total 100)."""
    leaves: list[dict] = []
    for pillar in pillar_scores.values():
        if not pillar.get("present"):
            continue
        for pk, param in (pillar.get("children") or {}).items():
            if not param.get("present"):
                continue
            if param.get("children"):
                for ck, child in param["children"].items():
                    if not child.get("present") or child.get("score") is None:
                        continue
                    gw = float(param["weight"]) * float(child["weight"]) / 100.0
                    leaves.append(_leaf(ck, child, gw, titles))
            elif param.get("score") is not None:
                leaves.append(_leaf(pk, param, float(param["weight"]), titles))
    return leaves


def build_reasons(pillar_scores: dict, decision: str, rating: str, total_score: float) -> dict:
    """Return {summary, positives[], negatives[]} explaining the score."""
    titles = _title_map()
    leaves = _collect_leaves(pillar_scores, titles)

    # Strengths: strong factors, ranked by how much weight they carry.
    positives = sorted(
        [l for l in leaves if l["score"] is not None and l["score"] >= 70],
        key=lambda l: (l["weight"], l["score"]), reverse=True,
    )[:3]
    # Weaknesses: weak factors, ranked by weight (biggest drag first).
    negatives = sorted(
        [l for l in leaves if l["score"] is not None and l["score"] <= 50],
        key=lambda l: (l["weight"], -l["score"]), reverse=True,
    )[:3]

    strong = ", ".join(p["factor"] for p in positives[:2]) or "—"
    summary = f"{decision.capitalize()} ({rating}, {round(total_score)}/100). Strengths: {strong}."
    if negatives:
        watch = ", ".join(n["factor"] for n in negatives[:2])
        summary += f" Watch: {watch}."

    return {"summary": summary, "positives": positives, "negatives": negatives}
