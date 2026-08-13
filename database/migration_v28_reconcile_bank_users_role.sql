-- ============================================================================
--  migration_v28_reconcile_bank_users_role.sql
--
--  Two v26 migrations (bank_admin portal + multi-bank foundation) each redefine
--  bank_users_role_check with a DIFFERENT allowed set, so the last one applied
--  silently wins. This reconciles them to the UNION so neither breaks:
--    - bank_admin portal needs 'custom' (free-text roles via custom_role_label)
--    - the foundation needs 'branch_manager' and 'bank_auditor'
--
--  Numbered v28 so it always applies AFTER both v26 files and is the final word,
--  regardless of same-version apply order. Idempotent.
-- ============================================================================

ALTER TABLE bank_users DROP CONSTRAINT IF EXISTS bank_users_role_check;
ALTER TABLE bank_users ADD CONSTRAINT bank_users_role_check
    CHECK (role IN (
        'bank_admin',
        'bank_officer',
        'bank_supervisor',
        'branch_manager',
        'bank_auditor',
        'custom'
    ));
