-- migration_v19_lrs_reasons.sql
-- LRS explainability: store the plain-language reason breakdown alongside the score.
-- Idempotent — safe to re-run.

ALTER TABLE lrs_scores
    ADD COLUMN IF NOT EXISTS reasons JSONB;
