"""Scorecard config loader + validator.

Loads config/scorecard.json (the 5-pillar weighted scorecard) and
config/risk_premium.json (score-band → ROI), validates their invariants once at
load time, and exposes them to the engine. Config is the single source of truth
for weights and bands — no scoring numbers live in code.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

_CONFIG_DIR = Path(__file__).resolve().parent / "config"
_SCORECARD_PATH = _CONFIG_DIR / "scorecard.json"
_RISK_PREMIUM_PATH = _CONFIG_DIR / "risk_premium.json"

_WEIGHT_TOLERANCE = 0.01  # allow tiny float drift (e.g. 34+33+33=100)


class ScorecardConfigError(ValueError):
    """Raised when a config file violates a structural invariant."""


def _approx_100(total: float) -> bool:
    return abs(total - 100.0) <= _WEIGHT_TOLERANCE


def _validate_node(node: dict, path: str) -> None:
    """Recursively validate a parameter node (leaf or composite)."""
    ntype = node.get("type")
    if ntype == "composite":
        children = node.get("children")
        if not children:
            raise ScorecardConfigError(f"{path}: composite node has no children")
        total = 0.0
        for name, child in children.items():
            if "weight" not in child:
                raise ScorecardConfigError(f"{path}.{name}: missing weight")
            total += float(child["weight"])
            _validate_node(child, f"{path}.{name}")
        if not _approx_100(total):
            raise ScorecardConfigError(
                f"{path}: child weights sum to {total}, expected 100"
            )
    elif ntype == "range":
        bands = node.get("bands")
        if not bands:
            raise ScorecardConfigError(f"{path}: range node has no bands")
        for b in bands:
            if "from" not in b or "to" not in b or "score" not in b:
                raise ScorecardConfigError(f"{path}: band missing from/to/score: {b}")
            if float(b["from"]) > float(b["to"]):
                raise ScorecardConfigError(f"{path}: band from>to: {b}")
        if not node.get("input_key"):
            raise ScorecardConfigError(f"{path}: range node missing input_key")
    elif ntype == "category":
        cats = node.get("categories")
        if not cats:
            raise ScorecardConfigError(f"{path}: category node has no categories")
        if "__default__" not in cats:
            raise ScorecardConfigError(f"{path}: category node missing __default__")
        if not node.get("input_key"):
            raise ScorecardConfigError(f"{path}: category node missing input_key")
    else:
        raise ScorecardConfigError(f"{path}: unknown node type {ntype!r}")


def _validate_scorecard(cfg: dict) -> None:
    pillars = cfg.get("pillars")
    if not pillars:
        raise ScorecardConfigError("scorecard: no pillars")
    total_w = 0.0
    for pkey, pillar in pillars.items():
        if "weight" not in pillar:
            raise ScorecardConfigError(f"pillar {pkey}: missing weight")
        total_w += float(pillar["weight"])
        params = pillar.get("parameters")
        if not params:
            raise ScorecardConfigError(f"pillar {pkey}: no parameters")
        has_disabled = any(not node.get("enabled", True) for node in params.values())
        pw = 0.0
        for name, node in params.items():
            if "weight" not in node:
                raise ScorecardConfigError(f"{pkey}.{name}: missing weight")
            pw += float(node["weight"])
            _validate_node(node, f"{pkey}.{name}")
        # When no params are disabled, weights must sum exactly to pillar weight.
        # When some are disabled the bank holds their original weights for reference;
        # the engine rescales at scoring time so we skip the strict check.
        if not has_disabled and abs(pw - float(pillar["weight"])) > _WEIGHT_TOLERANCE:
            raise ScorecardConfigError(
                f"pillar {pkey}: parameter weights sum to {pw}, "
                f"expected {pillar['weight']} (pillar weight)"
            )
    if not _approx_100(total_w):
        raise ScorecardConfigError(
            f"scorecard: pillar weights sum to {total_w}, expected 100"
        )
    th = cfg.get("decision_thresholds", {})
    if "approve" not in th or "refer" not in th:
        raise ScorecardConfigError("scorecard: decision_thresholds need approve+refer")


def _validate_risk_premium(cfg: dict) -> None:
    products = cfg.get("products")
    if not products:
        raise ScorecardConfigError("risk_premium: no products")
    for pkey, product in products.items():
        for field in ("base_roi", "min_amount", "max_amount", "max_tenure_months"):
            if field not in product:
                raise ScorecardConfigError(f"risk_premium {pkey}: missing {field}")
        bands = product.get("bands")
        if not bands:
            raise ScorecardConfigError(f"risk_premium {pkey}: no bands")
        # Bands must cover 0..100 with no gaps (sorted ascending by min_score).
        covered = sorted(((float(b["min_score"]), float(b["max_score"])) for b in bands))
        if covered[0][0] > 0:
            raise ScorecardConfigError(f"risk_premium {pkey}: bands don't cover 0")
        if covered[-1][1] < 100:
            raise ScorecardConfigError(f"risk_premium {pkey}: bands don't cover 100")


@lru_cache(maxsize=1)
def load_scorecard() -> dict:
    """Load + validate the scorecard config (cached)."""
    cfg = json.loads(_SCORECARD_PATH.read_text(encoding="utf-8"))
    _validate_scorecard(cfg)
    return cfg


@lru_cache(maxsize=1)
def load_risk_premium() -> dict:
    """Load + validate the risk-premium config (cached)."""
    cfg = json.loads(_RISK_PREMIUM_PATH.read_text(encoding="utf-8"))
    _validate_risk_premium(cfg)
    return cfg


def config_version() -> str:
    return load_scorecard().get("config_version", "unknown")


# ── DB-backed config (bank-configurable, mutable) ─────────────────────────────

_live_config: dict | None = None  # in-process cache; invalidated on PUT /api/lrs/config


async def get_db_config(pool) -> dict:
    """Return active scorecard config from DB; seeds from file on first call."""
    global _live_config
    if _live_config is not None:
        return _live_config
    row = await pool.fetchrow("SELECT config FROM lrs_scorecard_config WHERE id = 1")
    if not row:
        cfg = load_scorecard()
        await save_db_config(pool, cfg)
        return cfg
    # asyncpg returns JSONB columns as dicts directly
    cfg = dict(row["config"])
    _live_config = cfg
    return cfg


async def save_db_config(pool, config: dict) -> None:
    """Validate, persist to DB, and refresh in-process cache."""
    global _live_config
    _validate_scorecard(config)
    await pool.execute(
        "INSERT INTO lrs_scorecard_config(id, config, updated_at) "
        "VALUES(1, $1::jsonb, NOW()) "
        "ON CONFLICT (id) DO UPDATE SET config = $1::jsonb, updated_at = NOW()",
        json.dumps(config),
    )
    _live_config = config
