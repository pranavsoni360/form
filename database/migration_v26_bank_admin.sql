-- migration_v26_bank_admin.sql
-- Bank admin portal (design_handoff_finix Job 1). Adds the bank_admin role,
-- per-user status/branch/employee_id, the seat/quota/credit columns on banks,
-- and the invites / settings / activity-log tables that the users, usage and
-- settings screens bind to. Idempotent (IF NOT EXISTS / guarded).

-- ── bank_users: role now includes bank_admin + free-text custom roles ───────
-- The old CHECK allowed only officer/supervisor. Drop it and re-add a wider
-- one; custom roles are stored in custom_role_label with role = 'custom'.
ALTER TABLE bank_users DROP CONSTRAINT IF EXISTS bank_users_role_check;
ALTER TABLE bank_users
  ADD CONSTRAINT bank_users_role_check
  CHECK (role IN ('bank_admin', 'bank_officer', 'bank_supervisor', 'custom'));

ALTER TABLE bank_users ADD COLUMN IF NOT EXISTS custom_role_label VARCHAR(60);
ALTER TABLE bank_users ADD COLUMN IF NOT EXISTS branch VARCHAR(100);
ALTER TABLE bank_users ADD COLUMN IF NOT EXISTS employee_id VARCHAR(50);
ALTER TABLE bank_users ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';

-- Status lifecycle: active | invited | suspended. Backfill from is_active so
-- the two stay consistent (is_active remains the auth gate; status is the
-- product-facing state the users screen shows).
ALTER TABLE bank_users DROP CONSTRAINT IF EXISTS bank_users_status_check;
ALTER TABLE bank_users
  ADD CONSTRAINT bank_users_status_check
  CHECK (status IN ('active', 'invited', 'suspended'));
UPDATE bank_users SET status = CASE WHEN is_active THEN 'active' ELSE 'suspended' END
  WHERE status IS NULL OR status = '';

CREATE INDEX IF NOT EXISTS idx_bank_users_status ON bank_users(status);

-- ── banks: seat cap, minute quota, credit balance, quota period ─────────────
-- These four are set by VGIPL under contract (the settings page shows them
-- read-only in the "Managed by Virtual Galaxy" section). Defaults mirror the
-- design's Amravati tenant (20 seats, 40,000 min).
ALTER TABLE banks ADD COLUMN IF NOT EXISTS seat_cap INTEGER NOT NULL DEFAULT 20;
ALTER TABLE banks ADD COLUMN IF NOT EXISTS minute_quota INTEGER NOT NULL DEFAULT 40000;
ALTER TABLE banks ADD COLUMN IF NOT EXISTS credit_balance NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE banks ADD COLUMN IF NOT EXISTS quota_period_start DATE;
ALTER TABLE banks ADD COLUMN IF NOT EXISTS recording_retention_days INTEGER NOT NULL DEFAULT 180;
ALTER TABLE banks ADD COLUMN IF NOT EXISTS pii_redaction BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE banks ADD COLUMN IF NOT EXISTS account_manager VARCHAR(120);

-- ── bank_invites: user invites (real email delivery, 7-day expiry, held seat) ─
CREATE TABLE IF NOT EXISTS bank_invites (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id       UUID NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
    email         VARCHAR(255) NOT NULL,
    full_name     VARCHAR(255) NOT NULL,
    employee_id   VARCHAR(50),
    role          VARCHAR(30) NOT NULL,
    custom_role_label VARCHAR(60),
    branch        VARCHAR(100),
    token         VARCHAR(128) UNIQUE NOT NULL,
    status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
    seat_held     BOOLEAN NOT NULL DEFAULT true,
    invited_by    UUID,
    invited_by_name VARCHAR(255),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMPTZ NOT NULL,
    accepted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bank_invites_bank ON bank_invites(bank_id);
CREATE INDEX IF NOT EXISTS idx_bank_invites_token ON bank_invites(token);
CREATE INDEX IF NOT EXISTS idx_bank_invites_status ON bank_invites(status);

-- ── bank_settings: the four editable cards (calling/workflow/scorecard/notif) ─
-- One row per bank. Created lazily by the settings GET if absent.
CREATE TABLE IF NOT EXISTS bank_settings (
    bank_id                       UUID PRIMARY KEY REFERENCES banks(id) ON DELETE CASCADE,
    -- Calling
    calling_window_start          VARCHAR(5)  NOT NULL DEFAULT '09:00',
    calling_window_end            VARCHAR(5)  NOT NULL DEFAULT '19:00',
    max_retries_per_day           INTEGER     NOT NULL DEFAULT 3,
    caller_id_pool                VARCHAR(100),
    pause_outbound                BOOLEAN     NOT NULL DEFAULT false,
    -- Workflow
    second_approver_threshold     NUMERIC(14,2) NOT NULL DEFAULT 500000,
    maker_checker_differ          BOOLEAN     NOT NULL DEFAULT true,
    branch_scoping                BOOLEAN     NOT NULL DEFAULT false,
    -- Scorecard
    auto_approve_score            INTEGER     NOT NULL DEFAULT 72,
    weight_change_needs_approval  BOOLEAN     NOT NULL DEFAULT true,
    -- Notifications: [{event, template, recipients}]
    notifications                 JSONB       NOT NULL DEFAULT '[]'::jsonb,
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by                    UUID,
    updated_by_name               VARCHAR(255)
);

-- ── bank_activity_log: append-only; user CRUD + settings saves write here ────
CREATE TABLE IF NOT EXISTS bank_activity_log (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id       UUID NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
    actor_user_id UUID,
    actor_name    VARCHAR(255),
    action        VARCHAR(120) NOT NULL,
    detail        JSONB,
    target_user_id UUID,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bank_activity_bank ON bank_activity_log(bank_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_activity_target ON bank_activity_log(target_user_id);

-- ── bank_change_requests: "Request a change" on VG-managed settings ──────────
CREATE TABLE IF NOT EXISTS bank_change_requests (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id       UUID NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
    requested_by  UUID,
    requested_by_name VARCHAR(255),
    item          VARCHAR(120) NOT NULL,
    message       TEXT,
    status        VARCHAR(20) NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'resolved', 'declined')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bank_change_req_bank ON bank_change_requests(bank_id);
