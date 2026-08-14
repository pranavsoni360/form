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
        # Composite child weights are RELATIVE (rescaled to 100 at scoring time,
        # see engine._rescale_children). Require at least one enabled child with
        # weight > 0 so the composite can still produce a score.
        enabled_w = 0.0
        for name, child in children.items():
            if "weight" not in child:
                raise ScorecardConfigError(f"{path}.{name}: missing weight")
            if child.get("enabled", True):
                enabled_w += float(child["weight"])
            _validate_node(child, f"{path}.{name}")
        if enabled_w <= 0:
            raise ScorecardConfigError(
                f"{path}: needs at least one enabled sub-parameter with weight > 0"
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
    enabled_pillar_w = 0.0
    for pkey, pillar in pillars.items():
        if "weight" not in pillar:
            raise ScorecardConfigError(f"pillar {pkey}: missing weight")
        if pillar.get("enabled", True):
            enabled_pillar_w += float(pillar["weight"])
        params = pillar.get("parameters")
        if not params:
            raise ScorecardConfigError(f"pillar {pkey}: no parameters")
        enabled_w = 0.0
        for name, node in params.items():
            if "weight" not in node:
                raise ScorecardConfigError(f"{pkey}.{name}: missing weight")
            if node.get("enabled", True):
                enabled_w += float(node["weight"])
            _validate_node(node, f"{pkey}.{name}")
        # Parameter weights are RELATIVE proportions within a pillar — the engine
        # renormalises the enabled ones to fill the pillar weight at scoring time
        # (see engine._prepare_config). So they need not sum to the pillar weight;
        # we only require at least one enabled parameter with positive weight — but
        # only for ENABLED pillars (a disabled pillar is dropped entirely).
        if pillar.get("enabled", True) and enabled_w <= 0:
            raise ScorecardConfigError(
                f"pillar {pkey}: needs at least one enabled parameter with weight > 0"
            )
    # ENABLED pillar weights must sum to 100 (disabled pillars are excluded and
    # the bank keeps their weight for reference until re-enabled).
    if not _approx_100(enabled_pillar_w):
        raise ScorecardConfigError(
            f"scorecard: enabled pillar weights sum to {enabled_pillar_w}, expected 100"
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

_live_config: dict | None = None            # global-config cache (fallback / operator)
_live_config_by_bank: dict[str, dict] = {}  # per-bank live-version cache


def _decode_config(raw):
    # asyncpg returns JSONB as a str unless a codec is registered on the pool;
    # accept either a str (json) or an already-decoded dict.
    return json.loads(raw) if isinstance(raw, str) else dict(raw)


def invalidate_config_cache(bank_id=None) -> None:
    """Clear the in-process config cache — a specific bank, or everything."""
    global _live_config
    if bank_id is None:
        _live_config = None
        _live_config_by_bank.clear()
    else:
        _live_config_by_bank.pop(str(bank_id), None)


async def get_db_config(pool, bank_id=None) -> dict:
    """Return the active scorecard config.

    If ``bank_id`` has a LIVE per-bank version (scorecard_versions), use it;
    otherwise fall back to the global lrs_scorecard_config (id=1), which also
    seeds new banks. Operators (bank_id=None) always get the global config.
    """
    global _live_config

    # ── per-bank live version ──
    if bank_id is not None:
        key = str(bank_id)
        cached = _live_config_by_bank.get(key)
        if cached is not None:
            return cached
        row = await pool.fetchrow(
            "SELECT config FROM scorecard_versions "
            "WHERE bank_id = $1::uuid AND status = 'live' AND is_deleted = false "
            "ORDER BY version_number DESC LIMIT 1",
            key,
        )
        if row:
            cfg = _decode_config(row["config"])
            _live_config_by_bank[key] = cfg
            return cfg
        # no live version for this bank → fall through to the global config

    # ── global config (fallback / operator) ──
    if _live_config is not None:
        return _live_config
    row = await pool.fetchrow("SELECT config FROM lrs_scorecard_config WHERE id = 1")
    if not row:
        cfg = load_scorecard()
        await save_db_config(pool, cfg)
        return cfg
    cfg = _decode_config(row["config"])
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


async def save_bank_config(pool, bank_id, config: dict) -> int:
    """Persist a new LIVE scorecard version for one bank (archiving the previous
    live one, so the one-live-per-bank index holds). Validates first. Returns the
    new version_number and refreshes the per-bank cache."""
    _validate_scorecard(config)
    key = str(bank_id)
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "UPDATE scorecard_versions SET status='archived', updated_at=NOW() "
                "WHERE bank_id=$1::uuid AND status='live'",
                key,
            )
            nextver = await conn.fetchval(
                "SELECT COALESCE(MAX(version_number),0)+1 FROM scorecard_versions WHERE bank_id=$1::uuid",
                key,
            )
            await conn.execute(
                "INSERT INTO scorecard_versions (bank_id, version_number, config, status, change_summary) "
                "VALUES ($1::uuid, $2, $3::jsonb, 'live', 'edited via scorecard editor')",
                key, nextver, json.dumps(config),
            )
    invalidate_config_cache(key)
    return nextver
