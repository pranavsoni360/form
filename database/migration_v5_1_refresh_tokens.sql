-- ============================================================
-- Migration v5.1 — refresh_tokens V2→V3 column reconcile
--
-- Hotfix for missing column discovered post-v5 deploy. V3's
-- `_store_refresh_token` INSERTs a `vendor_id` column that
-- migration_v5 didn't add (the schema_v3 definition has it but
-- the V2 prod table didn't). Also relax the V2-era `user_type`
-- NOT NULL since V3 INSERTs don't supply it.
--
-- Idempotent. Drops nothing — preserves V2 user_type column
-- for rollback. Drop in migration_v6_drop_legacy.sql.
-- ============================================================
BEGIN;

ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS vendor_id UUID;

-- Relax user_type NOT NULL if it exists (V2-era constraint that
-- V3 INSERT statements don't satisfy). Wrapped in a DO block so
-- it's a no-op on fresh V3 databases that don't have user_type
-- at all.
DO $$ BEGIN
    EXECUTE 'ALTER TABLE refresh_tokens ALTER COLUMN user_type DROP NOT NULL';
EXCEPTION WHEN undefined_column THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_vendor ON refresh_tokens(vendor_id);

COMMIT;
