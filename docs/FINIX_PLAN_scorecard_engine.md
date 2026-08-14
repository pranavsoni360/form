# Execution Plan — Scorecard Engine → Per-Bank Live Version

**Status:** ready to execute (own session). **Risk:** ⚠️ affects loan scoring/decisions — requires before/after score verification. **Est. effort:** ~half a day incl. verification.

---

## Goal
Make each bank score its applicants against **its own** live scorecard, instead of one global scorecard shared by all banks. Today the versioned per-bank table exists but nothing uses it.

## Current state (verified)
- **Engine reads global**: `lrs/scorecard.py:157 get_db_config(pool)` reads `lrs_scorecard_config WHERE id=1` (one row, all banks) with an in-process cache `_live_config`.
- **Editor writes global**: `PUT /api/lrs/config` → `save_db_config` → writes `lrs_scorecard_config` id=1.
- **Scoring path**: `lrs/handlers.py:55` loads config, calls `service.score_application(app, config=config)` → `engine.score(inputs, config)` + `decision.decide(scorecard_cfg=config)`. **`app["bank_id"]` is already in scope at handlers.py:55.**
- **Per-bank table unused**: `scorecard_versions` (v32) — one `status='live'` row per bank, seeded from the global config. **Config shape is identical** (`_note, pillars, score_range, config_version, decision_thresholds`) — drop-in, no conversion.

## Target state
- `get_db_config(pool, bank_id)` returns the bank's live `scorecard_versions.config`, falling back to global `lrs_scorecard_config` when the bank has no live version.
- The editor writes the **bank's** live `scorecard_versions` row (new version, mark live, retire previous), scoped by the authenticated bank_id.
- Each score records **which version** produced it (auditability).

---

## Steps

### 1. Make config loading bank-aware (`lrs/scorecard.py`)
- Change cache `_live_config: dict` → `_live_config_by_bank: dict[str, dict]` (key = bank_id string, plus a `"__global__"` key for the fallback/operator).
- `async def get_db_config(pool, bank_id=None) -> dict`:
  - If `bank_id`: `SELECT config FROM scorecard_versions WHERE bank_id=$1 AND status='live' AND is_deleted=false LIMIT 1`. If found → cache + return.
  - Else / not found → existing global `lrs_scorecard_config WHERE id=1` path (unchanged).
  - Keep the same str-or-dict JSONB handling.
- Add `invalidate_config_cache(bank_id=None)` — clears one bank (or all) from the cache.

### 2. Pass bank at score time (`lrs/handlers.py:55`)
- `config = await sc_module.get_db_config(db_pool, app.get("bank_id"))`
- No other change — `config` already threads through `score_application`.

### 3. Bank-scoped editor write path (`lrs/routes.py` PUT /api/lrs/config)
- The endpoint already has `user` (bank or operator) from `get_current_bank_user`.
- **Bank user**: write a new `scorecard_versions` row for `user.bank_id` (increment `version_number`, `status='live'`, `config=$json`), and set the previous live row `status='archived'` — in one transaction (the NULLS-NOT-DISTINCT partial unique index enforces one live per bank/product).
- **Operator (no bank_id)**: keep writing the global `lrs_scorecard_config` (the default template new banks seed from).
- Call `invalidate_config_cache(user.bank_id)` after write.
- `GET /api/lrs/config`: same bank-aware read via `get_db_config(pool, user.bank_id)`.

### 4. Stamp the scored version
- When persisting a score (`handlers._persist` / `lrs_scores`), also store the `scorecard_versions.id` (or `version_number`) used. Add a nullable `scored_version_id uuid` column to `lrs_scores` (small migration v40) if not present, and set it. Lets you answer "which scorecard scored this application".

### 5. Cache coherence across processes
- The in-process cache is **per-uvicorn-worker**. `PUT` only invalidates the worker that served it. Options: (a) short TTL on the cache (e.g. 60s) so edits propagate; (b) a lightweight `pg_notify('scorecard_changed', bank_id)` LISTEN in each worker. Recommend (a) TTL for simplicity now, (b) later. **Document this** so an editor doesn't think a save "didn't take" for up to a minute on other workers.

---

## Verification (do NOT skip — this touches loan decisions)
1. **Baseline**: pick 3 already-scored applications across 2 banks. Record their current `total_score` + `decision`.
2. **No-op equivalence**: deploy to QA. Re-score the same 3 (`POST /api/lrs/rescore/{id}`). Since every bank's live version was seeded from the global config, **scores must be identical** to baseline. Any difference = a bug in the per-bank read.
3. **Divergence test**: edit Bank A's scorecard (raise a pillar weight). Re-score a Bank A app → score changes as expected. Re-score a Bank B app → **unchanged** (proves isolation).
4. **Fallback test**: a bank with no live version scores via the global config (temporarily archive a bank's live row, re-score, confirm it still scores).
5. Only then promote to prod, and re-run steps 1–2 on prod with a read-only rescore of a couple of apps.

## Rollback
- Revert the commit (engine falls back to global read). No schema rollback needed (v40 column is additive/nullable). The `scorecard_versions` rows written by the editor remain but are simply ignored by the reverted engine.

## Risk notes
- **Highest-stakes change in the backlog** — a wrong config read = wrong loan decisions. The no-op equivalence test (step 2) is the gate.
- Keep the global `lrs_scorecard_config` as the seed/fallback — do not delete it.
