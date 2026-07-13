"""LRS orchestration: application → providers → normalize → score → decision.

Pure async core (no DB) so it is fully unit-testable. The job handler and API
routes call `score_application` and persist/return the result.
"""
from __future__ import annotations

from typing import Any

from lrs import decision, engine, explain, normalize
from lrs.providers import FetchContext, get_providers

# LRS decision → the existing loan_applications.system_suggestion vocabulary
# (approve|review|deny) used by the portal's SUGGESTION_COLORS.
_SUGGESTION_MAP = {"approve": "approve", "refer": "review", "reject": "deny"}


def _pan(app: dict) -> str | None:
    return app.get("pan_number") or app.get("ekyc_pan") or app.get("pan")


def _aadhaar(app: dict) -> str | None:
    return app.get("aadhaar_number") or app.get("ekyc_adhar") or app.get("aadhaar")


async def score_application(
    app: dict,
    providers: list | None = None,
    config: dict | None = None,
) -> dict[str, Any]:
    """Run the full LRS pipeline for one application row. Returns a dict shaped
    for the lrs_scores table. Provider exceptions propagate (so the job retries);
    a provider that returns {} is treated as genuinely-absent data (re-weighted).
    Pass `config` to use the bank-configured scorecard instead of the file default.
    """
    ctx = FetchContext(pan=_pan(app), aadhaar=_aadhaar(app), phone=app.get("phone"), app=app)
    provs = providers if providers is not None else get_providers()

    payloads: list[dict] = []
    raw: dict[str, dict] = {}
    for p in provs:
        data = await p.fetch(ctx)
        payloads.append(data or {})
        raw[getattr(p, "name", "provider")] = data or {}

    inputs = normalize.to_canonical_inputs(app, payloads)
    result = engine.score(inputs, config=config)

    dinp = normalize.decision_inputs(app, inputs)
    d = decision.decide(
        result.total_score, scorecard_cfg=config,
        missing_pillars=result.missing_pillars, **dinp,
    )

    reasons = explain.build_reasons(
        result.pillar_scores, d.decision, result.rating, result.total_score
    )

    return {
        "status": "scored",
        "total_score": result.total_score,
        "decision": d.decision,
        "system_suggestion": _SUGGESTION_MAP.get(d.decision, "review"),
        "rating": result.rating,
        "recommended_amount": d.recommended_amount,
        "recommended_tenure_m": d.recommended_tenure_m,
        "recommended_emi": d.recommended_emi,
        "interest_rate": d.interest_rate,
        "risk_band": d.risk_band,
        "pillar_scores": result.pillar_scores,
        "effective_weights": result.effective_weights,
        "missing_pillars": result.missing_pillars,
        "incomplete": result.incomplete,
        "reasons": reasons,
        "raw_provider_data": raw,
        "config_version": result.config_version,
        "canonical_inputs": inputs,
    }
