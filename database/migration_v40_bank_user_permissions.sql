-- ============================================================================
--  v40 — Per-user permission overrides for bank users
--
--  WHY THIS EXISTS
--  ---------------
--  The bank-admin console lets an admin pick a role (Officer / Supervisor /
--  Bank admin / a `custom` label) when inviting or creating a user. Until now
--  that choice stored a STRING and granted nothing: authorisation was decided by
--  `bank_users.role` string comparisons in the routers, and the RBAC tables from
--  migration_v26_multi_bank_foundation.sql (roles / permissions /
--  role_permissions / user_roles) were created but never read by any code. The
--  `custom` role in particular was a display label with no permission set at
--  all, so "Recovery caller" and "Auditor, read only" looked meaningful in the
--  UI while behaving exactly like whatever the router's role check allowed.
--
--  This migration makes permissions real and, crucially, makes them
--  per-person-adjustable — the requirement being "default is set by role but it
--  is editable, and any specific right can be given to a particular person".
--
--  MODEL
--  -----
--  effective(user) = role_default(user.role)  UNION {grants}  EXCEPT {revokes}
--
--  Role defaults live in `permissions` + `bank_role_default_permissions` (keyed
--  by the bank_users.role string, so no dependency on the unused `roles` table
--  and its UUIDs). Per-user deltas live in `bank_user_permissions` with an
--  explicit `effect` of 'grant' or 'revoke'.
--
--  Storing DELTAS rather than a full per-user permission snapshot is deliberate:
--  when a new permission is added to a role default later, every user on that
--  role picks it up automatically instead of silently keeping an outdated frozen
--  copy. A revoke row is what makes "this one supervisor may not disburse"
--  expressible, which a grant-only table could not do.
--
--  Seeded defaults below mirror frontend/lib/auth/roles.ts ROLE_PERMISSIONS as
--  it stands today, so turning enforcement on changes nobody's access on day
--  one. bank_admin is seeded from the endpoints it already reaches in
--  backend/routers/bank_admin.py.
-- ============================================================================

-- ── Permission catalogue ────────────────────────────────────────────────────
-- `permissions` already exists (v26 section 4) with permission_code / category /
-- description / is_dangerous. It has never been populated. Fill it.
--
-- is_dangerous marks the rights that move money or destroy records; the console
-- shows those with a warning treatment and they are never granted by default to
-- a custom role.

INSERT INTO permissions (permission_code, category, description, is_dangerous) VALUES
    -- Applications: viewing scope
    ('application.view_assigned',    'applications',  'View applications assigned to this user',      FALSE),
    ('application.view_branch',      'applications',  'View all applications for their branch',       FALSE),
    ('application.view_all',         'applications',  'View all applications across the bank',        FALSE),
    -- Applications: decisions
    ('application.officer_approve',  'decisions',     'Officer-level approve',                        FALSE),
    ('application.officer_reject',   'decisions',     'Officer-level reject',                         FALSE),
    ('application.supervisor_approve','decisions',    'Supervisor-level approve',                     FALSE),
    ('application.supervisor_reject','decisions',     'Supervisor-level reject',                      FALSE),
    ('application.request_documents','decisions',     'Request further documents from the applicant', FALSE),
    ('application.cancel',           'decisions',     'Cancel an application',                        TRUE),
    ('application.disburse',         'decisions',     'Initiate disbursement (money out)',            TRUE),
    ('application.assign_vendor',    'decisions',     'Assign or withdraw an NBFC vendor',            TRUE),
    -- Calling
    ('calls.view',                   'calling',       'View call logs',                               FALSE),
    ('calls.listen_recording',       'calling',       'Play call recordings',                         FALSE),
    ('batch.upload',                 'calling',       'Upload a calling batch',                       FALSE),
    ('batch.start',                  'calling',       'Start batch calling',                          FALSE),
    ('batch.emergency_stop',         'calling',       'Emergency-stop all active calls',              TRUE),
    -- Scoring
    ('scorecard.view',               'scoring',       'View the scorecard configuration',             FALSE),
    ('scorecard.edit',               'scoring',       'Change scorecard weights and thresholds',      TRUE),
    ('scorecard.rescore',            'scoring',       'Re-score pending applications',                TRUE),
    -- Administration
    ('user.view',                    'administration','View bank users',                              FALSE),
    ('user.invite',                  'administration','Invite or create bank users',                  FALSE),
    ('user.edit',                    'administration','Change a user role, branch or details',        TRUE),
    ('user.suspend',                 'administration','Suspend or restore a user',                    TRUE),
    ('user.delete',                  'administration','Delete a user',                                TRUE),
    ('user.manage_permissions',      'administration','Change per-user permissions',                  TRUE),
    ('settings.view',                'administration','View bank settings',                           FALSE),
    ('settings.edit',                'administration','Change bank settings',                         TRUE),
    ('usage.view',                   'administration','View usage and call statistics',               FALSE),
    ('usage.export',                 'administration','Export usage data',                            FALSE),
    ('activity.view',                'administration','View the bank activity log',                   FALSE)
ON CONFLICT (permission_code) DO NOTHING;


-- ── Role defaults ───────────────────────────────────────────────────────────
-- Keyed by the bank_users.role STRING rather than roles.id: the `roles` table is
-- still unused and introducing its UUIDs here would couple this feature to an
-- unfinished migration. If/when `roles` is adopted, this table maps onto it
-- cleanly via role_code.
CREATE TABLE IF NOT EXISTS bank_role_default_permissions (
    role            VARCHAR(30)  NOT NULL,
    permission_code VARCHAR(100) NOT NULL REFERENCES permissions(permission_code) ON DELETE CASCADE,
    PRIMARY KEY (role, permission_code)
);

COMMENT ON TABLE bank_role_default_permissions IS
    'Default permission set per bank_users.role. Mirrors the frontend ROLE_PERMISSIONS map; per-user deltas in bank_user_permissions layer on top.';

-- bank_officer — matches ROLE_PERMISSIONS.officer plus the read rights the
-- officer screens already exercise (call logs, batch, scorecard view).
INSERT INTO bank_role_default_permissions (role, permission_code) VALUES
    ('bank_officer', 'application.view_assigned'),
    ('bank_officer', 'application.officer_approve'),
    ('bank_officer', 'application.officer_reject'),
    ('bank_officer', 'application.request_documents'),
    ('bank_officer', 'application.cancel'),
    ('bank_officer', 'calls.view'),
    ('bank_officer', 'batch.upload'),
    ('bank_officer', 'batch.start'),
    ('bank_officer', 'scorecard.view')
ON CONFLICT DO NOTHING;

-- bank_supervisor — officer rights plus the supervisor tier and disbursement.
INSERT INTO bank_role_default_permissions (role, permission_code) VALUES
    ('bank_supervisor', 'application.view_all'),
    ('bank_supervisor', 'application.view_branch'),
    ('bank_supervisor', 'application.officer_approve'),
    ('bank_supervisor', 'application.officer_reject'),
    ('bank_supervisor', 'application.supervisor_approve'),
    ('bank_supervisor', 'application.supervisor_reject'),
    ('bank_supervisor', 'application.request_documents'),
    ('bank_supervisor', 'application.cancel'),
    ('bank_supervisor', 'application.disburse'),
    ('bank_supervisor', 'application.assign_vendor'),
    ('bank_supervisor', 'calls.view'),
    ('bank_supervisor', 'calls.listen_recording'),
    ('bank_supervisor', 'batch.upload'),
    ('bank_supervisor', 'batch.start'),
    ('bank_supervisor', 'batch.emergency_stop'),
    ('bank_supervisor', 'scorecard.view'),
    ('bank_supervisor', 'scorecard.edit'),
    ('bank_supervisor', 'scorecard.rescore')
ON CONFLICT DO NOTHING;

-- bank_admin — the console it already owns. Deliberately NOT given lending
-- decision rights: administering seats is a different job from approving loans,
-- and an admin who needs both can be granted them explicitly per-user.
INSERT INTO bank_role_default_permissions (role, permission_code) VALUES
    ('bank_admin', 'user.view'),
    ('bank_admin', 'user.invite'),
    ('bank_admin', 'user.edit'),
    ('bank_admin', 'user.suspend'),
    ('bank_admin', 'user.delete'),
    ('bank_admin', 'user.manage_permissions'),
    ('bank_admin', 'settings.view'),
    ('bank_admin', 'settings.edit'),
    ('bank_admin', 'usage.view'),
    ('bank_admin', 'usage.export'),
    ('bank_admin', 'activity.view'),
    ('bank_admin', 'scorecard.view'),
    ('bank_admin', 'calls.view')
ON CONFLICT DO NOTHING;

-- `custom` intentionally gets NO defaults. A custom role is defined entirely by
-- its per-user grants, which is the whole point of choosing it. Seeding it with
-- anything would silently widen access for a label like "Auditor, read only".


-- ── Per-user deltas ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_user_permissions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES bank_users(id) ON DELETE CASCADE,
    permission_code VARCHAR(100) NOT NULL REFERENCES permissions(permission_code) ON DELETE CASCADE,
    -- 'grant' adds a right the role default lacks; 'revoke' removes one it has.
    -- Both directions are needed: without 'revoke' you cannot express "this
    -- supervisor specifically may not disburse".
    effect          VARCHAR(10)  NOT NULL,
    reason          TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by      UUID,

    CONSTRAINT chk_bup_effect CHECK (effect IN ('grant', 'revoke'))
);

-- One row per (user, permission): a permission is either granted, revoked, or
-- absent (= inherit the role default). Re-deciding overwrites rather than
-- stacking contradictory rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_user_permissions
    ON bank_user_permissions (user_id, permission_code);
CREATE INDEX IF NOT EXISTS idx_bank_user_permissions_user
    ON bank_user_permissions (user_id);

COMMENT ON TABLE bank_user_permissions IS
    'Per-user permission deltas layered over bank_role_default_permissions. effective = role_default UNION grants EXCEPT revokes. Deltas (not snapshots) so users inherit newly-added role defaults automatically.';


-- ── Pending invites carry their permission set too ──────────────────────────
-- An invite is accepted LATER, so the permission choices made at invite time
-- have to survive until then; otherwise a carefully-configured custom role
-- silently collapses to the plain role default on acceptance.
ALTER TABLE bank_invites
    ADD COLUMN IF NOT EXISTS permission_overrides JSONB;

COMMENT ON COLUMN bank_invites.permission_overrides IS
    'Permission deltas chosen at invite time, shape [{"permission_code":"...","effect":"grant|revoke"}]. Copied into bank_user_permissions when the invite is accepted.';
