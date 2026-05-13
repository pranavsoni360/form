-- ============================================
-- M2 — Migration V10
-- Auto-log every loan_applications.status change into status_transitions
-- ============================================
-- Why: today status_transitions is populated manually by application code at
-- key transition points (officer review, supervisor decision, disbursement).
-- Any UPDATE that misses the manual insert leaves a gap in the audit trail.
-- A DB-level AFTER UPDATE trigger guarantees that EVERY status change ends up
-- logged, even from psql, even from migrations, even if an app code path
-- forgets.
--
-- The trigger only fires when OLD.status IS DISTINCT FROM NEW.status (so
-- normal updates to other columns don't create noise rows).
--
-- changed_by_type defaults to 'system' for trigger-generated rows; if the
-- application wants to attribute the change to a user, it should call the
-- existing manual-insert code path (which sets changed_by_id + changed_by_type
-- before/after the UPDATE).
--
-- Safe to re-run.

CREATE OR REPLACE FUNCTION fn_log_loan_app_status_change()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO status_transitions (
            application_id,
            from_status,
            to_status,
            changed_by_type,
            created_at
        ) VALUES (
            NEW.id,
            OLD.status,
            NEW.status,
            'system',
            NOW()
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_loan_apps_status_log ON loan_applications;
CREATE TRIGGER trg_loan_apps_status_log
    AFTER UPDATE ON loan_applications
    FOR EACH ROW
    EXECUTE FUNCTION fn_log_loan_app_status_change();
