-- ============================================================================
--  migration_v29_reconcile_bank_admin_overlap.sql   ***DRAFT — REVIEW FIRST***
--
--  Reconciles the overlap between the two v26 migrations:
--    - migration_v26_bank_admin.sql       (colleague: dashboard-facing tables)
--    - migration_v26_multi_bank_foundation.sql (this repo: compliance foundation)
--
--  Principle: keep the dashboard working, converge on ONE source of truth,
--  throw away no one's work. Every duplicate column below is currently EMPTY
--  (verified on QA: 0 rows), so this is structural only — no data migration.
--
--  ⚠️  DO NOT APPLY until the dashboard owner has reviewed — item 2 turns
--      bank_activity_log into a VIEW, which changes how their code reads/writes
--      it (reads unchanged; writes redirected via an INSTEAD OF trigger).
-- ============================================================================

BEGIN;

-- ── 1. bank_users employee id: unify to employee_id (the dashboard's column) ──
-- employee_code (foundation) and employee_id (dashboard) are the same concept.
-- Keep the dashboard's name; carry the foundation's uniqueness guarantee over.
UPDATE bank_users SET employee_id = employee_code
    WHERE employee_id IS NULL AND employee_code IS NOT NULL;   -- both empty today; safe if not
DROP INDEX IF EXISTS uq_bank_users_employee_code;
ALTER TABLE bank_users DROP COLUMN IF EXISTS employee_code;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_users_employee_id
    ON bank_users (bank_id, UPPER(employee_id))
    WHERE employee_id IS NOT NULL AND is_deleted = FALSE;

-- ── 2. Audit: one compliant store (activity_log), dashboard interface kept ────
-- bank_activity_log (8 cols) is a subset of activity_log (31 cols, compliance:
-- ip/machine/before-after/session). Make bank_activity_log a VIEW over
-- activity_log so the dashboard's SELECTs are unchanged, and redirect its
-- INSERTs into activity_log with an INSTEAD OF trigger. bank_activity_log is
-- empty today, so no rows are lost.
--
-- ⚠️  id type changes uuid -> bigint (activity_log.id). If the dashboard treats
--     the activity-row id as a uuid, adjust there. Confirm before applying.
DROP TABLE IF EXISTS bank_activity_log;

CREATE VIEW bank_activity_log AS
    SELECT id,
           bank_id,
           actor_id        AS actor_user_id,
           actor_username  AS actor_name,
           action,
           after_data      AS detail,
           entity_id       AS target_user_id,
           created_at
      FROM activity_log
     WHERE bank_id IS NOT NULL;

CREATE OR REPLACE FUNCTION fn_bank_activity_log_insert() RETURNS trigger AS $$
BEGIN
    INSERT INTO activity_log
        (actor_type, actor_id, actor_username, bank_id, action,
         entity_type, entity_id, after_data, created_at)
    VALUES
        ('bank_user', NEW.actor_user_id, NEW.actor_name, NEW.bank_id, NEW.action,
         'bank_user', NEW.target_user_id, NEW.detail, COALESCE(NEW.created_at, NOW()));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bank_activity_log_insert ON bank_activity_log;
CREATE TRIGGER trg_bank_activity_log_insert
    INSTEAD OF INSERT ON bank_activity_log
    FOR EACH ROW EXECUTE FUNCTION fn_bank_activity_log_insert();

COMMIT;

-- ============================================================================
--  DEFERRED (documented, NOT done here — need the dashboard's input / other work)
--
--  3. bank_users.branch (text) vs branch_id (uuid FK):
--     Canonical = branch_id (integrity + powers the Branches screen). But the
--     Users form currently submits a branch *name*, and real branch rows don't
--     exist yet (only MAIN per bank). So keep `branch` as a display label until
--     the Branches screen is built and creates rows; then backfill branch_id
--     from `branch` and drop the text column. Not dropped now to avoid breaking
--     the live Users form.
--
--  4. bank_settings (typed, 1 row/bank) vs scoped_config (key-value, branch-
--     scoped): NOT a conflict — different shapes, complementary. Boundary:
--       • bank_settings  = the fixed Settings-screen cards (dashboard binds here)
--       • scoped_config  = branch-level overrides + extensible keys (retention,
--                          feature flags) that don't warrant a typed column
--     No migration; enforce the boundary in code review.
-- ============================================================================
