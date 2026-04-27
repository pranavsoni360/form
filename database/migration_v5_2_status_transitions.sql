-- ============================================================
-- Migration v5.2 — status_transitions V2→V3 column reconcile
--
-- Hotfix discovered post-v5 deploy. V3's record_transition INSERTs
-- `changed_by_role` and `changed_by`, neither of which existed on
-- the V2 prod table. V2 also had `changed_by_type NOT NULL` which
-- V3's INSERT doesn't supply.
--
-- Idempotent. Drops nothing — keeps V2 columns for rollback.
-- migration_v6_drop_legacy will eventually drop changed_by_type
-- and changed_by_id once V3 is proven stable for a week.
-- ============================================================
BEGIN;

ALTER TABLE status_transitions ADD COLUMN IF NOT EXISTS changed_by_role VARCHAR(20);
ALTER TABLE status_transitions ADD COLUMN IF NOT EXISTS changed_by      UUID;

-- Drop V2 NOT NULL on changed_by_type so V3 INSERTs (which don't
-- supply it) succeed. Wrapped in DO block: no-op on fresh V3 DBs
-- that don't have the column at all.
DO $$ BEGIN
    EXECUTE 'ALTER TABLE status_transitions ALTER COLUMN changed_by_type DROP NOT NULL';
EXCEPTION WHEN undefined_column THEN NULL; END $$;

-- V3 CHECK constraint on changed_by_role values (NULL allowed)
DO $$ BEGIN
    ALTER TABLE status_transitions ADD CONSTRAINT status_transitions_changed_by_role_check
        CHECK (changed_by_role IS NULL OR changed_by_role IN
               ('system', 'admin', 'bank_user', 'vendor_user', 'customer'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_status_transitions_changed_by ON status_transitions(changed_by);

COMMIT;
