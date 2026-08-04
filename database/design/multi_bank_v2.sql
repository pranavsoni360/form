-- ============================================================================
--  LOS — MULTI-BANK + BRANCHES SCHEMA (design v2)
-- ============================================================================
--  STATUS: DESIGN ARTEFACT. **NOT** wired into the migration runner.
--
--  backend/db_migrations.py globs `database/migration_*.sql`. This file lives in
--  database/design/ and is deliberately named so it can NEVER be auto-applied.
--  When approved, its sections are split into migration_v26..v31 (see §10).
--
--  HOW TO TEST (throwaway Postgres, nothing touched):
--      docker run --rm -d --name los_schema_test -e POSTGRES_PASSWORD=x -p 5599:5432 postgres:16
--      psql -h localhost -p 5599 -U postgres -c 'CREATE DATABASE los_design;'
--      # base schema first — this file ALTERs existing tables
--      psql ... -d los_design -f database/schema.sql
--      for f in database/migration_*.sql; do psql ... -d los_design -f "$f"; done
--      psql ... -d los_design -f database/design/multi_bank_v2.sql
--
--  CONVENTIONS (match the existing codebase exactly):
--    * every column add is ADD COLUMN IF NOT EXISTS
--    * every index is CREATE INDEX IF NOT EXISTS
--    * CHECK constraints are DROP IF EXISTS then ADD (never edited in place)
--    * idempotent throughout — the runner does NOT verify checksums
--      (_migrations.checksum is the literal string 'applied'), so an applied
--      file must never be edited; always add a new version instead.
--
--  HIERARCHY
--    PLATFORM (us)  ->  BANK (tenant)  ->  BRANCH  ->  operational rows
--
--  SCOPING INVARIANT
--    bank_id   NOT NULL on every operational table (after backfill).
--    branch_id NULLABLE — NULL means "bank-wide shared, not owned by a branch".
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ============================================================================
--  §1  SHARED HELPERS
-- ============================================================================

-- updated_at maintenance. The existing schema already ships
-- update_updated_at_column() (database/schema.sql:298); we reuse that name so
-- we do not end up with two competing functions.
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- Append-only guard for audit tables.
-- A lending audit trail that can be UPDATEd or DELETEd is not an audit trail.
-- Attach this to every log table; combine with a role-level
-- REVOKE UPDATE, DELETE ON <table> FROM <app_role> in production.
CREATE OR REPLACE FUNCTION fn_audit_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Table % is append-only (attempted %)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
--  §2  PLATFORM LAYER  (our company — no bank_id, cross-tenant by design)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 2.1 platform_admins — the super-admin team.
--
-- WHY NOT REUSE admin_users?  admin_users (database/schema.sql:199) has no
-- role CHECK, no created_by, and there is currently NO API to manage it at all
-- (verified: no admin_users CRUD endpoint exists — a super admin cannot even
-- create another super admin). We introduce a proper table and migrate the two
-- existing rows across, keeping admin_users readable during transition.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_admins (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           VARCHAR(255) NOT NULL,
    username        VARCHAR(100),
    password_hash   VARCHAR(255) NOT NULL,
    full_name       VARCHAR(255) NOT NULL,
    phone           VARCHAR(20),

    -- Coarse role kept for fast checks; fine-grained rights come from RBAC (§4).
    role            VARCHAR(30)  NOT NULL DEFAULT 'reviewer',

    mfa_enabled     BOOLEAN      NOT NULL DEFAULT FALSE,
    mfa_secret      VARCHAR(64),
    last_login_at   TIMESTAMPTZ,
    password_changed_at TIMESTAMPTZ,

    -- standard convention block
    status          VARCHAR(30)  NOT NULL DEFAULT 'active',
    status_reason   TEXT,
    remark          TEXT,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    is_deleted      BOOLEAN      NOT NULL DEFAULT FALSE,
    deleted_at      TIMESTAMPTZ,
    deleted_by      UUID,
    delete_reason   TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by      UUID REFERENCES platform_admins(id) ON DELETE SET NULL,
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_by      UUID
);

ALTER TABLE platform_admins DROP CONSTRAINT IF EXISTS chk_platform_admins_role;
ALTER TABLE platform_admins ADD CONSTRAINT chk_platform_admins_role
    CHECK (role IN ('super_admin', 'ops_admin', 'reviewer', 'support'));

-- Partial uniques: a soft-deleted admin's email/username becomes reusable.
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_admins_email
    ON platform_admins (LOWER(email)) WHERE is_deleted = FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_admins_username
    ON platform_admins (LOWER(username)) WHERE is_deleted = FALSE AND username IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_platform_admins_role   ON platform_admins (role) WHERE is_deleted = FALSE;

DROP TRIGGER IF EXISTS trg_platform_admins_upd ON platform_admins;
CREATE TRIGGER trg_platform_admins_upd BEFORE UPDATE ON platform_admins
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ---------------------------------------------------------------------------
-- 2.2 subscription_plans — commercial tiers + feature gates + quotas.
-- -1 in any max_* column means unlimited.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscription_plans (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                    VARCHAR(100) NOT NULL,
    plan_code               VARCHAR(30)  NOT NULL,
    description             TEXT,

    max_calls_per_month     INTEGER NOT NULL DEFAULT 1000,
    max_concurrent_calls    INTEGER NOT NULL DEFAULT 5,
    max_agents              INTEGER NOT NULL DEFAULT 2,
    max_users               INTEGER NOT NULL DEFAULT 5,
    max_branches            INTEGER NOT NULL DEFAULT 1,
    max_phone_numbers       INTEGER NOT NULL DEFAULT 2,
    max_form_expiry_hours   INTEGER NOT NULL DEFAULT 48,

    feature_whatsapp        BOOLEAN NOT NULL DEFAULT TRUE,
    feature_ai_review       BOOLEAN NOT NULL DEFAULT FALSE,  -- LRS scorecard
    feature_digilocker      BOOLEAN NOT NULL DEFAULT FALSE,
    feature_recording       BOOLEAN NOT NULL DEFAULT FALSE,
    feature_api_access      BOOLEAN NOT NULL DEFAULT FALSE,
    feature_analytics       BOOLEAN NOT NULL DEFAULT FALSE,
    feature_vendor_channel  BOOLEAN NOT NULL DEFAULT FALSE,
    feature_guarantor_calls BOOLEAN NOT NULL DEFAULT FALSE,
    feature_multi_branch    BOOLEAN NOT NULL DEFAULT FALSE,

    price_per_month         NUMERIC(12,2) NOT NULL DEFAULT 0,
    price_per_call          NUMERIC(10,4) NOT NULL DEFAULT 0,
    currency                VARCHAR(3)    NOT NULL DEFAULT 'INR',

    status          VARCHAR(30) NOT NULL DEFAULT 'active',
    status_reason   TEXT,
    remark          TEXT,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    is_deleted      BOOLEAN     NOT NULL DEFAULT FALSE,
    deleted_at      TIMESTAMPTZ,
    deleted_by      UUID,
    delete_reason   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      UUID,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by      UUID
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_plans_code ON subscription_plans (UPPER(plan_code)) WHERE is_deleted = FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_plans_name ON subscription_plans (LOWER(name))      WHERE is_deleted = FALSE;

DROP TRIGGER IF EXISTS trg_plans_upd ON subscription_plans;
CREATE TRIGGER trg_plans_upd BEFORE UPDATE ON subscription_plans
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ---------------------------------------------------------------------------
-- 2.3 agent_templates — reusable voice-agent personas defined by us and
-- cloned into a bank/branch as an agent_config (§5.1).
--
-- This is what replaces today's hardcoded personas: language/gender lookups
-- live in Python dicts (agent/config.py LANG_CONFIG / GENDER_CONFIG) and the
-- prompts are literals in agent/prompts.py — so a new bank cannot be onboarded
-- without a code change.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_templates (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                VARCHAR(255) NOT NULL,
    template_code       VARCHAR(50)  NOT NULL,
    agent_purpose       VARCHAR(40)  NOT NULL DEFAULT 'loan_enquiry',
    description         TEXT,

    default_language    VARCHAR(30)  NOT NULL DEFAULT 'hindi',
    default_gender      VARCHAR(10)  NOT NULL DEFAULT 'male',
    system_prompt       TEXT,
    opening_line        TEXT,
    call_questions      JSONB NOT NULL DEFAULT '[]'::jsonb,
    outcome_categories  JSONB NOT NULL DEFAULT '{}'::jsonb,
    max_call_duration_s INTEGER NOT NULL DEFAULT 360,

    status          VARCHAR(30) NOT NULL DEFAULT 'active',
    status_reason   TEXT,
    remark          TEXT,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    is_deleted      BOOLEAN     NOT NULL DEFAULT FALSE,
    deleted_at      TIMESTAMPTZ,
    deleted_by      UUID,
    delete_reason   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      UUID,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by      UUID
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_templates_code
    ON agent_templates (UPPER(template_code)) WHERE is_deleted = FALSE;

DROP TRIGGER IF EXISTS trg_agent_templates_upd ON agent_templates;
CREATE TRIGGER trg_agent_templates_upd BEFORE UPDATE ON agent_templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ---------------------------------------------------------------------------
-- 2.4 platform_audit_log — what OUR team does, across banks.
-- Kept separate from tenant audit so a bank export never leaks our activity.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_audit_log (
    id              BIGSERIAL PRIMARY KEY,
    actor_id        UUID,
    actor_email     VARCHAR(255),          -- snapshot: survives admin deletion
    actor_role      VARCHAR(30),

    action          VARCHAR(100) NOT NULL, -- 'bank.create', 'plan.assign', ...
    entity_type     VARCHAR(50),
    entity_id       UUID,
    target_bank_id  UUID,

    before_data     JSONB,
    after_data      JSONB,
    remark          TEXT,
    status_reason   TEXT,

    -- device / origin context
    session_id      VARCHAR(128),
    request_id      VARCHAR(64),
    ip_address      INET,
    machine_ip      INET,
    machine_name    VARCHAR(255),
    user_agent      TEXT,
    location        JSONB,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_audit_created ON platform_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_actor   ON platform_audit_log (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_bank    ON platform_audit_log (target_bank_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_action  ON platform_audit_log (action);

DROP TRIGGER IF EXISTS trg_platform_audit_append_only ON platform_audit_log;
CREATE TRIGGER trg_platform_audit_append_only
    BEFORE UPDATE OR DELETE ON platform_audit_log
    FOR EACH ROW EXECUTE FUNCTION fn_audit_append_only();


-- ---------------------------------------------------------------------------
-- 2.5 platform_alerts — quota / health / security alerts, deduped.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_alerts (
    id              BIGSERIAL PRIMARY KEY,
    severity        VARCHAR(20) NOT NULL DEFAULT 'warning',
    alert_type      VARCHAR(60) NOT NULL,
    bank_id         UUID,
    branch_id       UUID,
    title           VARCHAR(255) NOT NULL,
    body            TEXT,
    details         JSONB,
    dedupe_key      VARCHAR(190),
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by UUID,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE platform_alerts DROP CONSTRAINT IF EXISTS chk_platform_alerts_severity;
ALTER TABLE platform_alerts ADD CONSTRAINT chk_platform_alerts_severity
    CHECK (severity IN ('info', 'warning', 'critical'));

-- One OPEN alert per dedupe_key; resolving frees the key for a new occurrence.
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_alerts_open
    ON platform_alerts (dedupe_key) WHERE resolved_at IS NULL AND dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_platform_alerts_bank ON platform_alerts (bank_id, created_at DESC);


-- ============================================================================
--  §3  BANK LAYER
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 3.1 banks — ALTER the existing table (11 columns today: id, name, code,
--     contact_email, contact_phone, address, logo_url, status, created_at,
--     updated_at, vendor_limit). Today the ONLY unique identifiers are
--     id (UUID PK) and code (VARCHAR(50) UNIQUE).
--
-- Manager's identity list -> columns:
--     bank id     = id           (UUID PK, internal, never shown)
--     bank code   = code         (existing slug: PUSAD / BUCB / SFB / NRCB)
--     Bank MSTID  = bank_mst_id  (numeric master id in the Core Banking System)
--     bank key    = bank_key     (stable external handshake identifier)
--
-- bank_mst_id / bank_key are CBS/legacy REFERENCES, not secrets. Real API
-- secrets live in bank_api_keys (§3.4) hashed, so rotation never touches the
-- tenant row. The "MST" naming matches the external code-list service already
-- integrated at /api/code-list/{sql_mst_id} (a proxy to the VG master-data
-- API), so this stays consistent with the vocabulary the bank side already uses.
-- ---------------------------------------------------------------------------
ALTER TABLE banks
    ADD COLUMN IF NOT EXISTS bank_mst_id     INTEGER,
    ADD COLUMN IF NOT EXISTS bank_key        VARCHAR(64),
    ADD COLUMN IF NOT EXISTS legal_name      VARCHAR(255),
    ADD COLUMN IF NOT EXISTS ifsc_prefix     VARCHAR(11),
    ADD COLUMN IF NOT EXISTS gstin           VARCHAR(15),
    ADD COLUMN IF NOT EXISTS pan_number      VARCHAR(10),
    ADD COLUMN IF NOT EXISTS timezone        VARCHAR(64)  NOT NULL DEFAULT 'Asia/Kolkata',
    ADD COLUMN IF NOT EXISTS config          JSONB        NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS account_manager UUID,
    -- standard convention block
    ADD COLUMN IF NOT EXISTS status_reason   TEXT,
    ADD COLUMN IF NOT EXISTS remark          TEXT,
    ADD COLUMN IF NOT EXISTS is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS is_deleted      BOOLEAN      NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_by      UUID,
    ADD COLUMN IF NOT EXISTS delete_reason   TEXT,
    ADD COLUMN IF NOT EXISTS created_by      UUID,
    ADD COLUMN IF NOT EXISTS updated_by      UUID;

-- banks.status today allows only ('active','inactive'); add 'suspended' so the
-- super admin can suspend a defaulting client without deleting them.
ALTER TABLE banks DROP CONSTRAINT IF EXISTS banks_status_check;
ALTER TABLE banks ADD CONSTRAINT banks_status_check
    CHECK (status IN ('active', 'inactive', 'suspended', 'onboarding'));

-- Identity uniqueness (partial, so a soft-deleted bank frees its identifiers).
CREATE UNIQUE INDEX IF NOT EXISTS uq_banks_mst_id  ON banks (bank_mst_id) WHERE bank_mst_id IS NOT NULL AND is_deleted = FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_banks_key     ON banks (bank_key)    WHERE bank_key    IS NOT NULL AND is_deleted = FALSE;

-- banks.code has no DB-level format rule today (only a 20-char client cap).
-- Pin it: uppercase alphanumeric + underscore, 2..20 chars.
ALTER TABLE banks DROP CONSTRAINT IF EXISTS chk_banks_code_format;
ALTER TABLE banks ADD CONSTRAINT chk_banks_code_format
    CHECK (code ~ '^[A-Z0-9_]{2,20}$');

-- NOTE: the composite tenant FK used by child tables targets
-- bank_branches (bank_id, id) — see the unique index in §3.2. banks.id is
-- already the PK, so no extra index is needed here.


-- ---------------------------------------------------------------------------
-- 3.2 bank_branches — THE NEW LAYER.
-- Verified greenfield: zero occurrences of branch / branch_code / ifsc / micr
-- anywhere in the repo, so there is nothing to migrate or rename.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bank_branches (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id           UUID NOT NULL REFERENCES banks(id) ON DELETE CASCADE,

    -- identity (mirrors the bank set)
    branch_code       VARCHAR(20)  NOT NULL,   -- unique per bank
    branch_mst_id     INTEGER,                 -- CBS branch master id
    branch_key        VARCHAR(64),
    name              VARCHAR(255) NOT NULL,
    ifsc              VARCHAR(11),
    micr              VARCHAR(9),

    branch_type       VARCHAR(30)  NOT NULL DEFAULT 'branch',
    parent_branch_id  UUID REFERENCES bank_branches(id) ON DELETE SET NULL,

    -- location / contact
    address_line1     TEXT,
    address_line2     TEXT,
    city              VARCHAR(100),
    district          VARCHAR(100),
    state             VARCHAR(100),
    pincode           VARCHAR(6),
    contact_email     VARCHAR(255),
    contact_phone     VARCHAR(20),
    latitude          NUMERIC(10,7),
    longitude         NUMERIC(10,7),

    -- operating rules (fall back to bank/platform config when NULL)
    timezone          VARCHAR(64),
    call_start_hour    SMALLINT,
    call_end_hour      SMALLINT,
    working_days       JSONB,
    config             JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- standard convention block
    status          VARCHAR(30) NOT NULL DEFAULT 'active',
    status_reason   TEXT,
    remark          TEXT,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    is_deleted      BOOLEAN     NOT NULL DEFAULT FALSE,
    deleted_at      TIMESTAMPTZ,
    deleted_by      UUID,
    delete_reason   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      UUID,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by      UUID,

    -- A branch cannot be its own parent.
    CONSTRAINT chk_branch_not_self_parent CHECK (parent_branch_id IS NULL OR parent_branch_id <> id)
);

ALTER TABLE bank_branches DROP CONSTRAINT IF EXISTS chk_branches_type;
ALTER TABLE bank_branches ADD CONSTRAINT chk_branches_type
    CHECK (branch_type IN ('head_office', 'regional_office', 'main', 'branch', 'sub_branch', 'kiosk', 'legacy'));

ALTER TABLE bank_branches DROP CONSTRAINT IF EXISTS chk_branches_status;
ALTER TABLE bank_branches ADD CONSTRAINT chk_branches_status
    CHECK (status IN ('active', 'inactive', 'suspended'));

ALTER TABLE bank_branches DROP CONSTRAINT IF EXISTS chk_branches_code_format;
ALTER TABLE bank_branches ADD CONSTRAINT chk_branches_code_format
    CHECK (branch_code ~ '^[A-Z0-9_-]{2,20}$');

ALTER TABLE bank_branches DROP CONSTRAINT IF EXISTS chk_branches_ifsc_format;
ALTER TABLE bank_branches ADD CONSTRAINT chk_branches_ifsc_format
    CHECK (ifsc IS NULL OR ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$');

ALTER TABLE bank_branches DROP CONSTRAINT IF EXISTS chk_branches_pincode;
ALTER TABLE bank_branches ADD CONSTRAINT chk_branches_pincode
    CHECK (pincode IS NULL OR pincode ~ '^\d{6}$');

ALTER TABLE bank_branches DROP CONSTRAINT IF EXISTS chk_branches_call_hours;
ALTER TABLE bank_branches ADD CONSTRAINT chk_branches_call_hours
    CHECK ( (call_start_hour IS NULL AND call_end_hour IS NULL)
         OR (call_start_hour BETWEEN 0 AND 23 AND call_end_hour BETWEEN 1 AND 24
             AND call_end_hour > call_start_hour) );

-- branch_code unique WITHIN a bank (soft-deleted codes become reusable).
CREATE UNIQUE INDEX IF NOT EXISTS uq_branches_bank_code
    ON bank_branches (bank_id, UPPER(branch_code)) WHERE is_deleted = FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_branches_ifsc
    ON bank_branches (ifsc) WHERE ifsc IS NOT NULL AND is_deleted = FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_branches_mst
    ON bank_branches (bank_id, branch_mst_id) WHERE branch_mst_id IS NOT NULL AND is_deleted = FALSE;

CREATE INDEX IF NOT EXISTS idx_branches_bank   ON bank_branches (bank_id) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_branches_parent ON bank_branches (parent_branch_id) WHERE parent_branch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_branches_active ON bank_branches (bank_id, is_active) WHERE is_deleted = FALSE;

-- THE tenant-integrity anchor: lets every child table declare
--   FOREIGN KEY (bank_id, branch_id) REFERENCES bank_branches (bank_id, id)
-- making a cross-tenant branch reference impossible in the database itself,
-- rather than trusting application code to check it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_branches_bank_id_id ON bank_branches (bank_id, id);

DROP TRIGGER IF EXISTS trg_branches_upd ON bank_branches;
CREATE TRIGGER trg_branches_upd BEFORE UPDATE ON bank_branches
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- A branch's parent must belong to the same bank. Not expressible as a plain
-- FK because parent_branch_id alone carries no bank; enforce with a trigger.
CREATE OR REPLACE FUNCTION fn_branch_parent_same_bank()
RETURNS TRIGGER AS $$
DECLARE parent_bank UUID;
BEGIN
    IF NEW.parent_branch_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT bank_id INTO parent_bank FROM bank_branches WHERE id = NEW.parent_branch_id;
    IF parent_bank IS NULL OR parent_bank <> NEW.bank_id THEN
        RAISE EXCEPTION 'parent_branch_id % belongs to a different bank', NEW.parent_branch_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_branch_parent_same_bank ON bank_branches;
CREATE TRIGGER trg_branch_parent_same_bank
    BEFORE INSERT OR UPDATE OF parent_branch_id, bank_id ON bank_branches
    FOR EACH ROW EXECUTE FUNCTION fn_branch_parent_same_bank();


-- ---------------------------------------------------------------------------
-- 3.3 bank_subscriptions — plan binding + current-cycle counters.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bank_subscriptions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id         UUID NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
    plan_id         UUID NOT NULL REFERENCES subscription_plans(id),

    starts_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ends_at         TIMESTAMPTZ,
    billing_cycle   VARCHAR(20) NOT NULL DEFAULT 'monthly',

    -- per-bank overrides of plan defaults (NULL = inherit the plan)
    custom_call_limit        INTEGER,
    custom_concurrent_limit  INTEGER,
    custom_user_limit        INTEGER,
    custom_branch_limit      INTEGER,

    -- current cycle counters
    calls_this_cycle        INTEGER NOT NULL DEFAULT 0,
    forms_sent_this_cycle   INTEGER NOT NULL DEFAULT 0,
    apps_this_cycle         INTEGER NOT NULL DEFAULT 0,
    cycle_started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cycle_reset_at          TIMESTAMPTZ,

    status          VARCHAR(30) NOT NULL DEFAULT 'active',
    status_reason   TEXT,
    remark          TEXT,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    is_deleted      BOOLEAN     NOT NULL DEFAULT FALSE,
    deleted_at      TIMESTAMPTZ,
    deleted_by      UUID,
    delete_reason   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      UUID,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by      UUID
);

ALTER TABLE bank_subscriptions DROP CONSTRAINT IF EXISTS chk_subs_cycle;
ALTER TABLE bank_subscriptions ADD CONSTRAINT chk_subs_cycle
    CHECK (billing_cycle IN ('monthly', 'quarterly', 'annual', 'custom'));

ALTER TABLE bank_subscriptions DROP CONSTRAINT IF EXISTS chk_subs_dates;
ALTER TABLE bank_subscriptions ADD CONSTRAINT chk_subs_dates
    CHECK (ends_at IS NULL OR ends_at > starts_at);

-- Exactly ONE active subscription per bank; history is retained.
CREATE UNIQUE INDEX IF NOT EXISTS uq_subs_one_active_per_bank
    ON bank_subscriptions (bank_id) WHERE is_active = TRUE AND is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_subs_bank ON bank_subscriptions (bank_id);

DROP TRIGGER IF EXISTS trg_subs_upd ON bank_subscriptions;
CREATE TRIGGER trg_subs_upd BEFORE UPDATE ON bank_subscriptions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ---------------------------------------------------------------------------
-- 3.4 bank_api_keys — programmatic / CBS access. Hash only, never plaintext.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bank_api_keys (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id         UUID NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
    branch_id       UUID,
    name            VARCHAR(255) NOT NULL,
    key_prefix      VARCHAR(16)  NOT NULL,          -- shown in UI for identification
    key_hash        VARCHAR(255) NOT NULL,          -- sha256/bcrypt of the secret
    scopes          JSONB NOT NULL DEFAULT '[]'::jsonb,
    allowed_ips     JSONB NOT NULL DEFAULT '[]'::jsonb,

    last_used_at    TIMESTAMPTZ,
    last_used_ip    INET,
    use_count       BIGINT NOT NULL DEFAULT 0,
    expires_at      TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    revoked_by      UUID,
    revoke_reason   TEXT,

    remark          TEXT,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      UUID,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by      UUID,

    CONSTRAINT fk_api_keys_branch FOREIGN KEY (bank_id, branch_id)
        REFERENCES bank_branches (bank_id, id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_api_keys_hash ON bank_api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_bank ON bank_api_keys (bank_id) WHERE revoked_at IS NULL;

DROP TRIGGER IF EXISTS trg_api_keys_upd ON bank_api_keys;
CREATE TRIGGER trg_api_keys_upd BEFORE UPDATE ON bank_api_keys
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ---------------------------------------------------------------------------
-- 3.5 bank_onboarding — auto-created checklist, one row per bank.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bank_onboarding (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id         UUID NOT NULL UNIQUE REFERENCES banks(id) ON DELETE CASCADE,

    step_subscription_assigned  BOOLEAN NOT NULL DEFAULT FALSE,
    step_branches_created       BOOLEAN NOT NULL DEFAULT FALSE,
    step_bank_admin_created     BOOLEAN NOT NULL DEFAULT FALSE,
    step_bank_users_created     BOOLEAN NOT NULL DEFAULT FALSE,
    step_phone_pool_created     BOOLEAN NOT NULL DEFAULT FALSE,
    step_phone_numbers_added    BOOLEAN NOT NULL DEFAULT FALSE,
    step_agent_config_created   BOOLEAN NOT NULL DEFAULT FALSE,
    step_whatsapp_configured    BOOLEAN NOT NULL DEFAULT FALSE,
    step_scorecard_configured   BOOLEAN NOT NULL DEFAULT FALSE,
    step_test_call_completed    BOOLEAN NOT NULL DEFAULT FALSE,
    step_live_approved          BOOLEAN NOT NULL DEFAULT FALSE,

    completion_percent SMALLINT NOT NULL DEFAULT 0,
    is_live            BOOLEAN  NOT NULL DEFAULT FALSE,
    went_live_at       TIMESTAMPTZ,
    approved_by        UUID,

    remark          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by      UUID
);

DROP TRIGGER IF EXISTS trg_onboarding_upd ON bank_onboarding;
CREATE TRIGGER trg_onboarding_upd BEFORE UPDATE ON bank_onboarding
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Recompute completion_percent from the 11 step flags on every write.
CREATE OR REPLACE FUNCTION fn_onboarding_progress()
RETURNS TRIGGER AS $$
DECLARE done INTEGER;
BEGIN
    done :=
        NEW.step_subscription_assigned::int + NEW.step_branches_created::int +
        NEW.step_bank_admin_created::int    + NEW.step_bank_users_created::int +
        NEW.step_phone_pool_created::int    + NEW.step_phone_numbers_added::int +
        NEW.step_agent_config_created::int  + NEW.step_whatsapp_configured::int +
        NEW.step_scorecard_configured::int  + NEW.step_test_call_completed::int +
        NEW.step_live_approved::int;
    NEW.completion_percent := ROUND(done * 100.0 / 11);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_onboarding_progress ON bank_onboarding;
CREATE TRIGGER trg_onboarding_progress BEFORE INSERT OR UPDATE ON bank_onboarding
    FOR EACH ROW EXECUTE FUNCTION fn_onboarding_progress();

-- Auto-create the checklist when a bank is inserted.
CREATE OR REPLACE FUNCTION fn_bank_autocreate_onboarding()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO bank_onboarding (bank_id) VALUES (NEW.id)
    ON CONFLICT (bank_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bank_autocreate_onboarding ON banks;
CREATE TRIGGER trg_bank_autocreate_onboarding AFTER INSERT ON banks
    FOR EACH ROW EXECUTE FUNCTION fn_bank_autocreate_onboarding();


-- ---------------------------------------------------------------------------
-- 3.6 scoped_config — replaces the flat agent_system_config.
--
-- agent_system_config has PK (key) ONLY, so `emergency_stop` is physically
-- global: tripping it halts dialling for EVERY bank and the guarantor lane at
-- once, and POST /api/agent/batch-call implicitly clears it (so one bank
-- starting a batch un-pauses everyone). Scope it properly.
--
-- Resolution order: (bank, branch) -> (bank, NULL) -> (NULL, NULL).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scoped_config (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id         UUID REFERENCES banks(id) ON DELETE CASCADE,
    branch_id       UUID,
    config_key      VARCHAR(100) NOT NULL,
    config_value    TEXT,
    value_type      VARCHAR(20) NOT NULL DEFAULT 'string',
    description     TEXT,
    remark          TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by      UUID,

    CONSTRAINT fk_scoped_config_branch FOREIGN KEY (bank_id, branch_id)
        REFERENCES bank_branches (bank_id, id) ON DELETE CASCADE,
    -- a branch-scoped row must name its bank
    CONSTRAINT chk_scoped_config_shape CHECK (branch_id IS NULL OR bank_id IS NOT NULL)
);

-- NULLS NOT DISTINCT makes the global row (NULL, NULL, key) genuinely unique.
-- (Postgres 15+. On 14 and below, use two partial unique indexes instead.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_scoped_config
    ON scoped_config (bank_id, branch_id, config_key) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS idx_scoped_config_key ON scoped_config (config_key);


-- ============================================================================
--  §4  RBAC — roles + permissions
--
--  bank_users.role today is a hard 2-value CHECK ('bank_officer',
--  'bank_supervisor'), so adding branch_manager/bank_admin needs a migration
--  every time. Move authority into data.
-- ============================================================================

CREATE TABLE IF NOT EXISTS roles (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    role_code       VARCHAR(50)  NOT NULL,
    name            VARCHAR(100) NOT NULL,
    scope           VARCHAR(20)  NOT NULL,   -- platform | bank | branch
    description     TEXT,
    is_system       BOOLEAN NOT NULL DEFAULT FALSE,  -- system roles are not editable
    bank_id         UUID REFERENCES banks(id) ON DELETE CASCADE, -- NULL = global role
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    is_deleted      BOOLEAN NOT NULL DEFAULT FALSE,
    remark          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      UUID,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by      UUID
);

ALTER TABLE roles DROP CONSTRAINT IF EXISTS chk_roles_scope;
ALTER TABLE roles ADD CONSTRAINT chk_roles_scope
    CHECK (scope IN ('platform', 'bank', 'branch'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_code
    ON roles (UPPER(role_code), COALESCE(bank_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE is_deleted = FALSE;

CREATE TABLE IF NOT EXISTS permissions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    permission_code VARCHAR(100) NOT NULL UNIQUE,   -- 'application.approve'
    category        VARCHAR(50)  NOT NULL,
    description     TEXT,
    is_dangerous    BOOLEAN NOT NULL DEFAULT FALSE, -- needs extra confirmation
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id         UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id   UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    granted_by      UUID,
    PRIMARY KEY (role_id, permission_id)
);

-- A user (platform admin OR bank user) holds a role, optionally narrowed to a
-- bank and/or a single branch. This is what lets a bank_admin hand out a
-- branch-limited role — impossible with the current hardcoded model.
CREATE TABLE IF NOT EXISTS user_roles (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL,
    user_type       VARCHAR(20) NOT NULL,   -- platform_admin | bank_user | vendor_user
    role_id         UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    bank_id         UUID REFERENCES banks(id) ON DELETE CASCADE,
    branch_id       UUID,
    valid_from      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_until     TIMESTAMPTZ,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    remark          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      UUID,

    CONSTRAINT chk_user_roles_type CHECK (user_type IN ('platform_admin', 'bank_user', 'vendor_user')),
    CONSTRAINT fk_user_roles_branch FOREIGN KEY (bank_id, branch_id)
        REFERENCES bank_branches (bank_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_roles
    ON user_roles (user_id, user_type, role_id,
                   COALESCE(bank_id,   '00000000-0000-0000-0000-000000000000'::uuid),
                   COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles (user_id, user_type) WHERE is_active = TRUE;


-- ============================================================================
--  §5  AGENTIC LAYER (branch-owned)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 5.1 agent_configs — the per-branch voice bot.
--
-- Today every one of these lives in code or an env var:
--   agent_name  -> AGENT_NAME / UNION_BANK_AGENT_NAME (agent/state.py:34,37)
--   language    -> upload-time query param, then a hardcoded LANG_CONFIG dict
--   voice       -> hardcoded GENDER_CONFIG dict (shubh/pooja, Amit/Priya)
--   persona     -> literal prompt text in agent/prompts.py
--   bank name   -> derived from agent_type, so EVERY non-account_opening call
--                  announces itself as "ABC Bank" regardless of bank_id
--                  (services/dispatcher.py:666-706). That is the single biggest
--                  blocker to true multi-bank operation and this table fixes it.
--
-- The /ops Batch screen already asks for exactly Language / Voice / Agent type /
-- FROM NUMBER per upload — those four dimensions are this table, promoted to
-- branch defaults that a batch inherits (per-batch override stays via
-- agent_batches.preferred_phone_id).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_configs (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id             UUID NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
    branch_id           UUID,                       -- NULL = bank-wide default
    template_id         UUID REFERENCES agent_templates(id) ON DELETE SET NULL,
    pool_id             UUID,                       -- FK added in §7 (phone_pools)

    name                VARCHAR(255) NOT NULL,
    config_code         VARCHAR(50)  NOT NULL,
    agent_purpose       VARCHAR(40)  NOT NULL DEFAULT 'loan_enquiry',

    -- LiveKit dispatch target — the worker registers under this name.
    livekit_agent_name  VARCHAR(100) NOT NULL,

    -- what the customer hears
    display_bank_name   VARCHAR(255),   -- spoken name; falls back to banks.name
    persona_name        VARCHAR(60),    -- "Amit" / "Priya"
    language            VARCHAR(30) NOT NULL DEFAULT 'hindi',
    agent_gender        VARCHAR(10) NOT NULL DEFAULT 'male',
    tts_speaker         VARCHAR(40),    -- e.g. shubh / pooja
    tts_language_code   VARCHAR(10),    -- hi-IN / mr-IN / en-IN
    stt_language        VARCHAR(10),    -- hi / en
    speech_pace         NUMERIC(4,2) NOT NULL DEFAULT 1.06,

    system_prompt       TEXT,
    opening_line        TEXT,
    call_questions      JSONB NOT NULL DEFAULT '[]'::jsonb,
    outcome_categories  JSONB NOT NULL DEFAULT '{}'::jsonb,
    max_call_duration_s INTEGER NOT NULL DEFAULT 360,
    retry_limit         SMALLINT NOT NULL DEFAULT 2,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,

    status          VARCHAR(30) NOT NULL DEFAULT 'active',
    status_reason   TEXT,
    remark          TEXT,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    is_deleted      BOOLEAN     NOT NULL DEFAULT FALSE,
    deleted_at      TIMESTAMPTZ,
    deleted_by      UUID,
    delete_reason   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      UUID,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by      UUID,

    CONSTRAINT fk_agent_configs_branch FOREIGN KEY (bank_id, branch_id)
        REFERENCES bank_branches (bank_id, id) ON DELETE CASCADE
);

ALTER TABLE agent_configs DROP CONSTRAINT IF EXISTS chk_agent_configs_purpose;
ALTER TABLE agent_configs ADD CONSTRAINT chk_agent_configs_purpose
    CHECK (agent_purpose IN ('loan_enquiry', 'account_opening', 'guarantor_consent', 'collections', 'custom'));

ALTER TABLE agent_configs DROP CONSTRAINT IF EXISTS chk_agent_configs_gender;
ALTER TABLE agent_configs ADD CONSTRAINT chk_agent_configs_gender
    CHECK (agent_gender IN ('male', 'female'));

ALTER TABLE agent_configs DROP CONSTRAINT IF EXISTS chk_agent_configs_pace;
ALTER TABLE agent_configs ADD CONSTRAINT chk_agent_configs_pace
    CHECK (speech_pace BETWEEN 0.50 AND 2.00);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_configs_code
    ON agent_configs (bank_id, UPPER(config_code)) WHERE is_deleted = FALSE;

-- One DEFAULT config per (bank, branch, purpose). branch_id NULL = bank default.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_configs_default
    ON agent_configs (bank_id, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), agent_purpose)
    WHERE is_active = TRUE AND is_deleted = FALSE;

CREATE INDEX IF NOT EXISTS idx_agent_configs_bank   ON agent_configs (bank_id) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_agent_configs_branch ON agent_configs (branch_id) WHERE branch_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_agent_configs_upd ON agent_configs;
CREATE TRIGGER trg_agent_configs_upd BEFORE UPDATE ON agent_configs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ============================================================================
--  §6  AUDIT LAYER  (the compliance core)
--
--  Shared "who did what, from where" block on activity_log + login_audit:
--    actor_type/id/username, bank_id, branch_id, session_id, request_id,
--    ip_address, machine_ip, machine_name, user_agent, location JSONB
--
--  actor_username is denormalised deliberately: an audit row must stay
--  readable after the user is deactivated or renamed, and it removes a join
--  from every audit query.
--
--  All five tables are append-only (trigger + REVOKE in production).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 6.1 activity_log — every mutating action by any user, anywhere.
-- BIGSERIAL (not UUID): this is the highest-volume table in the schema and a
-- monotonic key keeps inserts append-friendly and range scans cheap.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_log (
    id              BIGSERIAL PRIMARY KEY,

    actor_type      VARCHAR(20)  NOT NULL,
    actor_id        UUID,
    actor_username  VARCHAR(150),
    actor_role      VARCHAR(50),

    bank_id         UUID,
    branch_id       UUID,

    action          VARCHAR(100) NOT NULL,   -- 'application.approve', 'bank.update'
    module          VARCHAR(50),             -- 'applications' | 'batch' | 'admin' ...
    entity_type     VARCHAR(50),
    entity_id       UUID,
    entity_ref      VARCHAR(100),            -- human ref, e.g. loan_id

    http_method     VARCHAR(10),
    endpoint        VARCHAR(255),
    http_status     INTEGER,

    before_data     JSONB,
    after_data      JSONB,
    changed_fields  TEXT[],

    result          VARCHAR(20)  NOT NULL DEFAULT 'success',
    error_message   TEXT,
    remark          TEXT,
    status_reason   TEXT,

    -- origin / device context
    session_id      VARCHAR(128),
    request_id      VARCHAR(64),
    ip_address      INET,
    machine_ip      INET,
    machine_name    VARCHAR(255),
    user_agent      TEXT,
    location        JSONB,

    duration_ms     INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS chk_activity_actor_type;
ALTER TABLE activity_log ADD CONSTRAINT chk_activity_actor_type
    CHECK (actor_type IN ('platform_admin', 'bank_user', 'vendor_user', 'customer', 'system', 'agent'));

ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS chk_activity_result;
ALTER TABLE activity_log ADD CONSTRAINT chk_activity_result
    CHECK (result IN ('success', 'failure', 'denied'));

CREATE INDEX IF NOT EXISTS idx_activity_created  ON activity_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_bank     ON activity_log (bank_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_branch   ON activity_log (branch_id, created_at DESC) WHERE branch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_actor    ON activity_log (actor_type, actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_entity   ON activity_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_action   ON activity_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_request  ON activity_log (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_ip       ON activity_log (ip_address) WHERE ip_address IS NOT NULL;

DROP TRIGGER IF EXISTS trg_activity_append_only ON activity_log;
CREATE TRIGGER trg_activity_append_only BEFORE UPDATE OR DELETE ON activity_log
    FOR EACH ROW EXECUTE FUNCTION fn_audit_append_only();

-- SCALE NOTE: at ~5000 calls/day this table grows fastest. When it passes
-- ~50M rows, convert to monthly RANGE partitions on created_at:
--   CREATE TABLE activity_log (...) PARTITION BY RANGE (created_at);
-- and add a BRIN index on created_at. Do it before the table is huge —
-- partitioning after the fact needs a full rewrite.


-- ---------------------------------------------------------------------------
-- 6.2 login_audit — every authentication event, success AND failure.
--
-- Today NOTHING records a successful login: only an overwritten last_login_at
-- on three user tables, and login_attempts is a per-username counter that is
-- DELETEd on success (main.py:787) — so the failure history is destroyed by
-- the next good login. This table is the forensic record and is never pruned.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_audit (
    id              BIGSERIAL PRIMARY KEY,

    event           VARCHAR(30) NOT NULL,   -- see CHECK below
    actor_type      VARCHAR(20) NOT NULL,
    actor_id        UUID,                   -- NULL when the username was unknown
    username_tried  VARCHAR(150) NOT NULL,
    actor_username  VARCHAR(150),
    actor_role      VARCHAR(50),

    bank_id         UUID,
    branch_id       UUID,

    success         BOOLEAN NOT NULL,
    failure_reason  VARCHAR(100),           -- bad_password | unknown_user | locked | inactive | mfa_failed
    attempt_number  INTEGER,

    -- token / session linkage so a session can be traced end-to-end
    session_id      VARCHAR(128),
    jti             VARCHAR(64),
    token_expires_at TIMESTAMPTZ,

    -- origin / device context
    request_id      VARCHAR(64),
    ip_address      INET,
    machine_ip      INET,
    machine_name    VARCHAR(255),
    user_agent      TEXT,
    device_fingerprint VARCHAR(128),
    location        JSONB,

    remark          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE login_audit DROP CONSTRAINT IF EXISTS chk_login_audit_event;
ALTER TABLE login_audit ADD CONSTRAINT chk_login_audit_event
    CHECK (event IN ('login_success', 'login_failure', 'logout', 'lockout',
                     'token_refresh', 'token_revoked', 'password_change',
                     'password_reset', 'otp_sent', 'otp_verified', 'otp_failed',
                     'session_expired', 'mfa_challenge'));

ALTER TABLE login_audit DROP CONSTRAINT IF EXISTS chk_login_audit_actor_type;
ALTER TABLE login_audit ADD CONSTRAINT chk_login_audit_actor_type
    CHECK (actor_type IN ('platform_admin', 'bank_user', 'vendor_user', 'customer', 'unknown'));

CREATE INDEX IF NOT EXISTS idx_login_audit_created  ON login_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_audit_user     ON login_audit (actor_type, actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_audit_username ON login_audit (LOWER(username_tried), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_audit_ip       ON login_audit (ip_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_audit_bank     ON login_audit (bank_id, created_at DESC);
-- brute-force / credential-stuffing detection
CREATE INDEX IF NOT EXISTS idx_login_audit_failures ON login_audit (created_at DESC) WHERE success = FALSE;

DROP TRIGGER IF EXISTS trg_login_audit_append_only ON login_audit;
CREATE TRIGGER trg_login_audit_append_only BEFORE UPDATE OR DELETE ON login_audit
    FOR EACH ROW EXECUTE FUNCTION fn_audit_append_only();


-- ---------------------------------------------------------------------------
-- 6.3 application_status_log — single-writer replacement for
--     status_transitions.
--
-- Problems being fixed:
--   * DOUBLE WRITES — record_transition() (main.py:1084) AND the
--     trg_loan_apps_status_log trigger both fire, so every change produces one
--     attributed row plus one anonymous 'system' row, and the officer UI shows
--     both (main.py:1731).
--   * changed_by_id is passed the APPLICATION's own id at main.py:2726 and
--     main.py:3592 instead of an actor.
--   * from_status is hardcoded 'draft' at those same two sites.
--   * no actor identity snapshot, no FK, no IP/session, no reason code
--     (rejection reason is smuggled into notes as "[Reason: x] y").
--   * money leaving is NOT logged: vendors.py:778 sets disbursed_at without
--     touching status, so neither writer fires.
--
-- Rule going forward: ONE writer (the application layer). The DB trigger is
-- retained only as a safety net that writes a clearly-marked
-- 'trigger_fallback' row when the app layer forgot — never a duplicate.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_status_log (
    id              BIGSERIAL PRIMARY KEY,
    application_id  UUID NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,
    bank_id         UUID,
    branch_id       UUID,

    from_status     VARCHAR(40),
    to_status       VARCHAR(40) NOT NULL,

    actor_type      VARCHAR(20) NOT NULL,
    actor_id        UUID,
    actor_username  VARCHAR(150),   -- snapshot
    actor_role      VARCHAR(50),

    reason_code     VARCHAR(60),    -- structured, replaces "[Reason: ...]" in notes
    reason_text     TEXT,
    notes           TEXT,
    remark          TEXT,

    -- decision economics, so an approval is auditable without joining
    decided_amount  NUMERIC(15,2),
    decided_tenure_m SMALLINT,
    decided_roi     NUMERIC(6,3),

    source          VARCHAR(30) NOT NULL DEFAULT 'app',  -- app | trigger_fallback | migration
    session_id      VARCHAR(128),
    request_id      VARCHAR(64),
    jti             VARCHAR(64),
    ip_address      INET,
    machine_ip      INET,
    machine_name    VARCHAR(255),
    user_agent      TEXT,
    location        JSONB,
    metadata        JSONB,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE application_status_log DROP CONSTRAINT IF EXISTS chk_appstatus_actor_type;
ALTER TABLE application_status_log ADD CONSTRAINT chk_appstatus_actor_type
    CHECK (actor_type IN ('platform_admin', 'bank_user', 'vendor_user', 'customer', 'system', 'agent'));

ALTER TABLE application_status_log DROP CONSTRAINT IF EXISTS chk_appstatus_source;
ALTER TABLE application_status_log ADD CONSTRAINT chk_appstatus_source
    CHECK (source IN ('app', 'trigger_fallback', 'migration'));

CREATE INDEX IF NOT EXISTS idx_appstatus_app     ON application_status_log (application_id, created_at);
CREATE INDEX IF NOT EXISTS idx_appstatus_created ON application_status_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_appstatus_bank    ON application_status_log (bank_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_appstatus_actor   ON application_status_log (actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_appstatus_to      ON application_status_log (to_status);

DROP TRIGGER IF EXISTS trg_appstatus_append_only ON application_status_log;
CREATE TRIGGER trg_appstatus_append_only BEFORE UPDATE OR DELETE ON application_status_log
    FOR EACH ROW EXECUTE FUNCTION fn_audit_append_only();


-- ---------------------------------------------------------------------------
-- 6.4 application_field_history — field-level before/after.
--
-- form_autosave_log exists in schema.sql for exactly this and has never been
-- written. Also: field_sources.modified is flipped only in React state and
-- field_sources is not in AUTOSAVE_COLUMNS (main.py:1203), so today there is
-- NO record of what a customer changed, from what, to what, or when.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_field_history (
    id              BIGSERIAL PRIMARY KEY,
    application_id  UUID NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,
    bank_id         UUID,
    branch_id       UUID,

    field_key       VARCHAR(100) NOT NULL,
    field_label     VARCHAR(255),
    old_value       TEXT,
    new_value       TEXT,
    value_source    VARCHAR(30),   -- pan | aadhaar | agent_call | customer | officer | cbs
    is_override     BOOLEAN NOT NULL DEFAULT FALSE, -- customer overrode a verified value

    step_number     SMALLINT,
    actor_type      VARCHAR(20) NOT NULL,
    actor_id        UUID,
    actor_username  VARCHAR(150),

    session_id      VARCHAR(128),
    request_id      VARCHAR(64),
    ip_address      INET,
    machine_ip      INET,
    machine_name    VARCHAR(255),
    user_agent      TEXT,
    location        JSONB,
    remark          TEXT,

    changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fieldhist_app     ON application_field_history (application_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_fieldhist_field   ON application_field_history (application_id, field_key);
CREATE INDEX IF NOT EXISTS idx_fieldhist_changed ON application_field_history (changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_fieldhist_override ON application_field_history (application_id) WHERE is_override = TRUE;

DROP TRIGGER IF EXISTS trg_fieldhist_append_only ON application_field_history;
CREATE TRIGGER trg_fieldhist_append_only BEFORE UPDATE OR DELETE ON application_field_history
    FOR EACH ROW EXECUTE FUNCTION fn_audit_append_only();


-- ---------------------------------------------------------------------------
-- 6.5 officer_action_log — append-only officer/supervisor decisions.
--
-- loan_applications keeps officer decisions in SINGLE-SLOT columns
-- (officer_id, officer_reviewed_at, officer_notes, supervisor_*). A second
-- officer touching the same application OVERWRITES the first, and nothing
-- enforces maker/checker separation (officer_id may equal supervisor_id).
-- Every decision becomes a row here; the columns stay as a denormalised
-- "latest decision" cache for the list screens.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS officer_action_log (
    id              BIGSERIAL PRIMARY KEY,
    application_id  UUID NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,
    bank_id         UUID,
    branch_id       UUID,

    officer_id      UUID,
    officer_username VARCHAR(150),
    officer_role    VARCHAR(50),      -- bank_officer | bank_supervisor | bank_admin

    action          VARCHAR(50) NOT NULL,   -- approve | reject | request_documents | disburse | cancel | reassign | note
    decision_level  VARCHAR(20),            -- maker | checker
    from_status     VARCHAR(40),
    to_status       VARCHAR(40),

    reason_code     VARCHAR(60),
    reason_text     TEXT,
    notes           TEXT,
    remark          TEXT,

    decided_amount  NUMERIC(15,2),
    decided_tenure_m SMALLINT,
    decided_roi     NUMERIC(6,3),
    lrs_score_at_decision NUMERIC(6,2),

    session_id      VARCHAR(128),
    request_id      VARCHAR(64),
    ip_address      INET,
    machine_ip      INET,
    machine_name    VARCHAR(255),
    user_agent      TEXT,
    location        JSONB,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE officer_action_log DROP CONSTRAINT IF EXISTS chk_officer_action;
ALTER TABLE officer_action_log ADD CONSTRAINT chk_officer_action
    CHECK (action IN ('approve', 'reject', 'request_documents', 'documents_received',
                      'disburse', 'cancel', 'withdraw', 'reassign', 'note', 'reopen'));

CREATE INDEX IF NOT EXISTS idx_officeract_app     ON officer_action_log (application_id, created_at);
CREATE INDEX IF NOT EXISTS idx_officeract_officer ON officer_action_log (officer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_officeract_bank    ON officer_action_log (bank_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_officeract_action  ON officer_action_log (action, created_at DESC);

DROP TRIGGER IF EXISTS trg_officeract_append_only ON officer_action_log;
CREATE TRIGGER trg_officeract_append_only BEFORE UPDATE OR DELETE ON officer_action_log
    FOR EACH ROW EXECUTE FUNCTION fn_audit_append_only();


-- ============================================================================
--  §7  ALTER EXISTING OPERATIONAL TABLES
--  All additive. branch_id is NULLABLE everywhere so nothing breaks on day 1.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 7.1 bank_users — pin users to a branch.
--
-- IMPORTANT: bank_users.username is GLOBALLY UNIQUE today (migration_v2.sql:27),
-- so two banks cannot both have a "manager1". For a real multi-bank product the
-- constraint must become per-bank. That is a BREAKING change for the login
-- lookup (which currently resolves a user by username alone), so it is staged:
--   step 1 (here): add the per-bank unique index alongside the global one
--   step 2 (code): login must take bank_code/bank_id + username
--   step 3 (later migration): drop the global constraint
-- Do NOT drop bank_users_username_key until the login path is updated.
-- ---------------------------------------------------------------------------
ALTER TABLE bank_users
    ADD COLUMN IF NOT EXISTS branch_id       UUID,
    ADD COLUMN IF NOT EXISTS employee_code   VARCHAR(50),
    ADD COLUMN IF NOT EXISTS designation     VARCHAR(100),
    ADD COLUMN IF NOT EXISTS phone           VARCHAR(20),
    ADD COLUMN IF NOT EXISTS reports_to      UUID,
    ADD COLUMN IF NOT EXISTS max_approval_amount NUMERIC(15,2),
    ADD COLUMN IF NOT EXISTS mfa_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS last_login_ip   INET,
    -- standard convention block
    ADD COLUMN IF NOT EXISTS status          VARCHAR(30) NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS status_reason   TEXT,
    ADD COLUMN IF NOT EXISTS remark          TEXT,
    ADD COLUMN IF NOT EXISTS is_deleted      BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_by      UUID,
    ADD COLUMN IF NOT EXISTS delete_reason   TEXT,
    ADD COLUMN IF NOT EXISTS created_by      UUID,
    ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_by      UUID;

-- role CHECK today is a hard 2-value enum; widen it. Fine-grained authority
-- still comes from RBAC (§4) — this stays as the coarse label.
ALTER TABLE bank_users DROP CONSTRAINT IF EXISTS bank_users_role_check;
ALTER TABLE bank_users ADD CONSTRAINT bank_users_role_check
    CHECK (role IN ('bank_officer', 'bank_supervisor', 'bank_admin', 'branch_manager', 'bank_auditor'));

ALTER TABLE bank_users DROP CONSTRAINT IF EXISTS fk_bank_users_branch;
ALTER TABLE bank_users ADD CONSTRAINT fk_bank_users_branch
    FOREIGN KEY (bank_id, branch_id) REFERENCES bank_branches (bank_id, id) ON DELETE SET NULL;

ALTER TABLE bank_users DROP CONSTRAINT IF EXISTS fk_bank_users_reports_to;
ALTER TABLE bank_users ADD CONSTRAINT fk_bank_users_reports_to
    FOREIGN KEY (reports_to) REFERENCES bank_users(id) ON DELETE SET NULL;

ALTER TABLE bank_users DROP CONSTRAINT IF EXISTS chk_bank_users_not_self_manager;
ALTER TABLE bank_users ADD CONSTRAINT chk_bank_users_not_self_manager
    CHECK (reports_to IS NULL OR reports_to <> id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_users_bank_username
    ON bank_users (bank_id, LOWER(username)) WHERE is_deleted = FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_users_employee_code
    ON bank_users (bank_id, UPPER(employee_code)) WHERE employee_code IS NOT NULL AND is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_bank_users_branch ON bank_users (branch_id) WHERE branch_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_bank_users_upd ON bank_users;
CREATE TRIGGER trg_bank_users_upd BEFORE UPDATE ON bank_users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ---------------------------------------------------------------------------
-- 7.2 phone_pools / phone_numbers — branch ownership.
--
-- phone_numbers has NO tenant column at all today: tenancy is reachable only
-- via pool_id -> phone_pools.bank_id, and the dispatcher's selection query
-- (services/dispatcher.py:149-161) never constrains it — so Bank A's batch can
-- dial from Bank B's caller ID. Denormalising bank_id/branch_id onto
-- phone_numbers lets the hot selection query filter by tenant with no join.
-- ---------------------------------------------------------------------------
ALTER TABLE phone_pools
    ADD COLUMN IF NOT EXISTS branch_id       UUID,
    ADD COLUMN IF NOT EXISTS pool_code       VARCHAR(50),
    ADD COLUMN IF NOT EXISTS status          VARCHAR(30) NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS status_reason   TEXT,
    ADD COLUMN IF NOT EXISTS remark          TEXT,
    ADD COLUMN IF NOT EXISTS is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS is_deleted      BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_by      UUID,
    ADD COLUMN IF NOT EXISTS delete_reason   TEXT,
    ADD COLUMN IF NOT EXISTS created_by      UUID,
    ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_by      UUID;

ALTER TABLE phone_pools DROP CONSTRAINT IF EXISTS fk_phone_pools_branch;
ALTER TABLE phone_pools ADD CONSTRAINT fk_phone_pools_branch
    FOREIGN KEY (bank_id, branch_id) REFERENCES bank_branches (bank_id, id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_phone_pools_branch ON phone_pools (branch_id) WHERE branch_id IS NOT NULL;

ALTER TABLE phone_numbers
    ADD COLUMN IF NOT EXISTS bank_id         UUID,
    ADD COLUMN IF NOT EXISTS branch_id       UUID,
    ADD COLUMN IF NOT EXISTS provider        VARCHAR(50),
    ADD COLUMN IF NOT EXISTS caller_id_name  VARCHAR(100),
    ADD COLUMN IF NOT EXISTS status_reason   TEXT,
    ADD COLUMN IF NOT EXISTS remark          TEXT,
    ADD COLUMN IF NOT EXISTS is_deleted      BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_by      UUID,
    ADD COLUMN IF NOT EXISTS delete_reason   TEXT,
    ADD COLUMN IF NOT EXISTS created_by      UUID,
    ADD COLUMN IF NOT EXISTS updated_by      UUID;

ALTER TABLE phone_numbers DROP CONSTRAINT IF EXISTS fk_phone_numbers_bank;
ALTER TABLE phone_numbers ADD CONSTRAINT fk_phone_numbers_bank
    FOREIGN KEY (bank_id) REFERENCES banks(id) ON DELETE CASCADE;

ALTER TABLE phone_numbers DROP CONSTRAINT IF EXISTS fk_phone_numbers_branch;
ALTER TABLE phone_numbers ADD CONSTRAINT fk_phone_numbers_branch
    FOREIGN KEY (bank_id, branch_id) REFERENCES bank_branches (bank_id, id) ON DELETE SET NULL;

-- The index the fixed dispatcher query needs (tenant + eligibility + cooldown).
CREATE INDEX IF NOT EXISTS idx_phone_numbers_tenant_pick
    ON phone_numbers (bank_id, status, auto_dial_eligible, cooldown_until)
    WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_phone_numbers_branch
    ON phone_numbers (branch_id) WHERE branch_id IS NOT NULL;

-- agent_configs.pool_id FK — declared here, after phone_pools is guaranteed present.
ALTER TABLE agent_configs DROP CONSTRAINT IF EXISTS fk_agent_configs_pool;
ALTER TABLE agent_configs ADD CONSTRAINT fk_agent_configs_pool
    FOREIGN KEY (pool_id) REFERENCES phone_pools(id) ON DELETE SET NULL;


-- ---------------------------------------------------------------------------
-- 7.3 agent_calls / agent_batches — branch + config attribution.
--
-- NOTE ON bank_id NULLABILITY: agent_calls and agent_batches are each created
-- by TWO migrations with different definitions — migration_agent_tables.sql
-- (bank_id NOT NULL, sorts as version 0 so it wins on a fresh DB) and
-- migration_v2.sql (bank_id nullable). Both use CREATE TABLE IF NOT EXISTS, so
-- whichever ran first wins and prod may differ from a fresh dev DB. Normalise
-- deliberately rather than assuming.
-- ---------------------------------------------------------------------------
ALTER TABLE agent_calls
    ADD COLUMN IF NOT EXISTS branch_id       UUID,
    ADD COLUMN IF NOT EXISTS agent_config_id UUID,
    ADD COLUMN IF NOT EXISTS status_reason   TEXT,
    ADD COLUMN IF NOT EXISTS remark          TEXT,
    ADD COLUMN IF NOT EXISTS is_deleted      BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_by      UUID,
    ADD COLUMN IF NOT EXISTS delete_reason   TEXT;

ALTER TABLE agent_calls DROP CONSTRAINT IF EXISTS fk_agent_calls_branch;
ALTER TABLE agent_calls ADD CONSTRAINT fk_agent_calls_branch
    FOREIGN KEY (bank_id, branch_id) REFERENCES bank_branches (bank_id, id) ON DELETE SET NULL;

ALTER TABLE agent_calls DROP CONSTRAINT IF EXISTS fk_agent_calls_config;
ALTER TABLE agent_calls ADD CONSTRAINT fk_agent_calls_config
    FOREIGN KEY (agent_config_id) REFERENCES agent_configs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agent_calls_branch
    ON agent_calls (branch_id, created_at DESC) WHERE branch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_calls_bank_branch_created
    ON agent_calls (bank_id, branch_id, created_at DESC);

ALTER TABLE agent_batches
    ADD COLUMN IF NOT EXISTS branch_id       UUID,
    ADD COLUMN IF NOT EXISTS agent_config_id UUID,
    ADD COLUMN IF NOT EXISTS status_reason   TEXT,
    ADD COLUMN IF NOT EXISTS remark          TEXT,
    ADD COLUMN IF NOT EXISTS is_deleted      BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_by      UUID,
    ADD COLUMN IF NOT EXISTS delete_reason   TEXT,
    ADD COLUMN IF NOT EXISTS created_by      UUID,
    ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE agent_batches DROP CONSTRAINT IF EXISTS fk_agent_batches_branch;
ALTER TABLE agent_batches ADD CONSTRAINT fk_agent_batches_branch
    FOREIGN KEY (bank_id, branch_id) REFERENCES bank_branches (bank_id, id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agent_batches_branch ON agent_batches (branch_id) WHERE branch_id IS NOT NULL;


-- ---------------------------------------------------------------------------
-- 7.4 loan_applications — branch attribution + the missing status values.
--
-- The live CHECK omits 'documents_requested' AND 'disbursed', yet
-- main.py:1953 writes status='documents_requested' — so "Request Documents"
-- raises CheckViolation and 500s on every click today. Restate the full list.
-- ---------------------------------------------------------------------------
ALTER TABLE loan_applications
    ADD COLUMN IF NOT EXISTS branch_id       UUID,
    ADD COLUMN IF NOT EXISTS agent_config_id UUID,
    ADD COLUMN IF NOT EXISTS status_reason   TEXT,
    ADD COLUMN IF NOT EXISTS remark          TEXT,
    ADD COLUMN IF NOT EXISTS is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS is_deleted      BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_by      UUID,
    ADD COLUMN IF NOT EXISTS delete_reason   TEXT,
    ADD COLUMN IF NOT EXISTS created_by      UUID,
    ADD COLUMN IF NOT EXISTS updated_by      UUID;

ALTER TABLE loan_applications DROP CONSTRAINT IF EXISTS fk_loan_apps_branch;
ALTER TABLE loan_applications ADD CONSTRAINT fk_loan_apps_branch
    FOREIGN KEY (bank_id, branch_id) REFERENCES bank_branches (bank_id, id) ON DELETE SET NULL;

ALTER TABLE loan_applications DROP CONSTRAINT IF EXISTS loan_applications_status_check;
ALTER TABLE loan_applications ADD CONSTRAINT loan_applications_status_check
    CHECK (status IN (
        'draft', 'submitted', 'system_reviewed',
        'officer_approved', 'officer_rejected',
        'documents_requested', 'documents_submitted',
        'approved', 'supervisor_rejected',
        'disbursed',
        'cancelled', 'withdrawn'
    ));

CREATE INDEX IF NOT EXISTS idx_loan_apps_branch
    ON loan_applications (branch_id, created_at DESC) WHERE branch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_loan_apps_bank_branch_status
    ON loan_applications (bank_id, branch_id, status, created_at DESC);


-- ---------------------------------------------------------------------------
-- 7.5 guarantor_consent_calls — give it a real tenant FK.
-- Today bank_id is a bare UUID with no FK and no index.
-- ---------------------------------------------------------------------------
ALTER TABLE guarantor_consent_calls
    ADD COLUMN IF NOT EXISTS branch_id     UUID,
    ADD COLUMN IF NOT EXISTS status_reason TEXT,
    ADD COLUMN IF NOT EXISTS remark        TEXT;

ALTER TABLE guarantor_consent_calls DROP CONSTRAINT IF EXISTS fk_gcc_bank;
ALTER TABLE guarantor_consent_calls ADD CONSTRAINT fk_gcc_bank
    FOREIGN KEY (bank_id) REFERENCES banks(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_gcc_bank ON guarantor_consent_calls (bank_id);

ALTER TABLE guarantor_consent_calls DROP CONSTRAINT IF EXISTS chk_gcc_status;
ALTER TABLE guarantor_consent_calls ADD CONSTRAINT chk_gcc_status
    CHECK (status IN ('pending', 'calling', 'completed', 'no_answer', 'failed', 'skipped'));


-- ============================================================================
--  §8  SEED DATA
-- ============================================================================

-- 8.1 Subscription plans
INSERT INTO subscription_plans
    (name, plan_code, description, max_calls_per_month, max_concurrent_calls,
     max_agents, max_users, max_branches, max_phone_numbers,
     feature_ai_review, feature_digilocker, feature_recording,
     feature_api_access, feature_analytics, feature_vendor_channel,
     feature_guarantor_calls, feature_multi_branch, price_per_month)
VALUES
    ('Starter',      'STARTER', 'Single branch, low volume',     500,  3,  1,  3,  1, 2,  FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE,  4999),
    ('Professional', 'PRO',     'Multi-branch, full features',  5000, 10,  5, 25, 10, 10, TRUE,  TRUE,  TRUE,  TRUE,  TRUE,  TRUE,  TRUE,  TRUE,  19999),
    ('Enterprise',   'ENT',     'Unlimited',                      -1, 50, -1, -1, -1, -1, TRUE,  TRUE,  TRUE,  TRUE,  TRUE,  TRUE,  TRUE,  TRUE,  49999)
ON CONFLICT DO NOTHING;

-- 8.2 Permissions
INSERT INTO permissions (permission_code, category, description, is_dangerous) VALUES
    ('bank.create',            'platform',     'Create a bank',                        TRUE),
    ('bank.update',            'platform',     'Edit bank details',                    FALSE),
    ('bank.suspend',           'platform',     'Suspend / reactivate a bank',          TRUE),
    ('bank.delete',            'platform',     'Soft-delete a bank',                   TRUE),
    ('bank.view_all',          'platform',     'Read data across all banks',           FALSE),
    ('plan.assign',            'platform',     'Assign a subscription plan',           TRUE),
    ('platform_admin.manage',  'platform',     'Create / edit platform admins',        TRUE),
    ('agent_template.manage',  'platform',     'Manage agent templates',               FALSE),
    ('system_config.manage',   'platform',     'Change platform configuration',        TRUE),

    ('branch.create',          'bank',         'Create a branch',                      FALSE),
    ('branch.update',          'bank',         'Edit a branch',                        FALSE),
    ('branch.delete',          'bank',         'Soft-delete a branch',                 TRUE),
    ('bank_user.manage',       'bank',         'Create / edit bank users',             TRUE),
    ('bank_user.reset_password','bank',        'Reset another user password',           TRUE),
    ('role.assign',            'bank',         'Assign roles to users',                TRUE),
    ('agent_config.manage',    'bank',         'Manage agent configuration',           FALSE),
    ('phone_pool.manage',      'bank',         'Manage phone pools and numbers',       FALSE),
    ('scorecard.manage',       'bank',         'Edit the LRS scorecard',               TRUE),
    ('api_key.manage',         'bank',         'Issue / revoke API keys',              TRUE),

    ('application.view',       'application',  'View applications',                    FALSE),
    ('application.officer_review','application','Officer approve / reject',            FALSE),
    ('application.supervisor_review','application','Supervisor approve / reject',      FALSE),
    ('application.request_documents','application','Request documents',                FALSE),
    ('application.disburse',   'application',  'Initiate disbursement',                TRUE),
    ('application.cancel',     'application',  'Cancel an application',                TRUE),
    ('application.export',     'application',  'Export application data',              TRUE),

    ('batch.upload',           'calling',      'Upload a calling batch',               FALSE),
    ('batch.start',            'calling',      'Start dialling',                       TRUE),
    ('batch.emergency_stop',   'calling',      'Emergency-stop dialling',              TRUE),
    ('call.view',              'calling',      'View calls',                           FALSE),
    ('call.listen_recording',  'calling',      'Listen to call recordings',            TRUE),

    ('audit.view',             'audit',        'View audit and activity logs',         FALSE),
    ('audit.export',           'audit',        'Export audit logs',                    TRUE)
ON CONFLICT (permission_code) DO NOTHING;

-- 8.3 System roles
INSERT INTO roles (role_code, name, scope, description, is_system) VALUES
    ('SUPER_ADMIN',      'Super Admin',      'platform', 'Full control across all banks', TRUE),
    ('OPS_ADMIN',        'Ops Admin',        'platform', 'Operate all banks, no billing', TRUE),
    ('PLATFORM_REVIEWER','Reviewer',         'platform', 'Read-only across all banks',    TRUE),
    ('SUPPORT',          'Support',          'platform', 'Read-only + resend messages',   TRUE),
    ('BANK_ADMIN',       'Bank Admin',       'bank',     'Full control within the bank',  TRUE),
    ('BANK_AUDITOR',     'Bank Auditor',     'bank',     'Read-only + audit logs',        TRUE),
    ('BRANCH_MANAGER',   'Branch Manager',   'branch',   'Full control within a branch',  TRUE),
    ('BANK_SUPERVISOR',  'Supervisor',       'branch',   'Final approve / reject',        TRUE),
    ('BANK_OFFICER',     'Officer',          'branch',   'First-level review',            TRUE)
ON CONFLICT DO NOTHING;

-- 8.4 Grant permissions to system roles
--     SUPER_ADMIN gets everything.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.role_code = 'SUPER_ADMIN'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_code IN (
    'application.view','application.officer_review','call.view','batch.upload')
WHERE r.role_code = 'BANK_OFFICER'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_code IN (
    'application.view','application.officer_review','application.supervisor_review',
    'application.request_documents','application.disburse','application.cancel',
    'call.view','call.listen_recording','batch.upload','batch.start')
WHERE r.role_code = 'BANK_SUPERVISOR'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.category IN ('application','calling')
    OR p.permission_code IN ('branch.update','bank_user.manage','role.assign',
                             'agent_config.manage','phone_pool.manage','audit.view')
WHERE r.role_code = 'BRANCH_MANAGER'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
    ON p.category IN ('bank','application','calling','audit')
WHERE r.role_code = 'BANK_ADMIN'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_code IN (
    'application.view','call.view','audit.view','audit.export')
WHERE r.role_code = 'BANK_AUDITOR'
ON CONFLICT DO NOTHING;

-- 8.5 Global default config (replaces the flat agent_system_config rows)
INSERT INTO scoped_config (bank_id, branch_id, config_key, config_value, value_type, description) VALUES
    (NULL, NULL, 'emergency_stop',         'false',     'bool', 'Halt ALL dialling (platform-wide)'),
    (NULL, NULL, 'call_start_hour',        '10',        'int',  'Default earliest call hour (IST)'),
    (NULL, NULL, 'call_end_hour',          '24',        'int',  'Default latest call hour (IST)'),
    (NULL, NULL, 'form_link_expiry_hours', '48',        'int',  'Default form token expiry'),
    (NULL, NULL, 'otp_expiry_minutes',     '10',        'int',  'OTP validity window'),
    (NULL, NULL, 'max_concurrent_calls',   '50',        'int',  'Platform-wide concurrency cap')
ON CONFLICT DO NOTHING;

-- 8.6 Default branch per existing bank, so nothing is orphaned after rollout.
--     Idempotent: only creates MAIN where the bank has no branch yet.
INSERT INTO bank_branches (bank_id, branch_code, name, branch_type, remark, created_at)
SELECT b.id, 'MAIN', b.name || ' — Main Branch', 'main',
       'Auto-created during multi-branch rollout', NOW()
FROM banks b
WHERE NOT EXISTS (SELECT 1 FROM bank_branches bb WHERE bb.bank_id = b.id)
ON CONFLICT DO NOTHING;

-- 8.7 LEGACY tenant for orphaned rows.
--     ~25-29% of QA operational rows have bank_id IS NULL (8/28 applications,
--     36/142 calls, 29/122 batches, 1/2 pools). Do NOT silently assign them to
--     a real bank — that fabricates attribution on loan records. Park them here
--     and review manually, so bank_id NOT NULL can be enforced truthfully.
INSERT INTO banks (name, code, status, remark, created_at)
VALUES ('LEGACY / UNASSIGNED', 'LEGACY', 'inactive',
        'Holds pre-multi-tenant rows that had no bank_id. Review and reassign.', NOW())
ON CONFLICT (code) DO NOTHING;

INSERT INTO bank_branches (bank_id, branch_code, name, branch_type, remark)
SELECT b.id, 'LEGACY', 'Legacy / Unassigned', 'legacy',
       'Holds pre-multi-tenant rows that had no branch.'
FROM banks b WHERE b.code = 'LEGACY'
ON CONFLICT DO NOTHING;


-- ============================================================================
--  §9  CONVENIENCE VIEWS
-- ============================================================================

-- Effective quota per bank (plan defaults with per-bank overrides applied).
CREATE OR REPLACE VIEW v_bank_effective_quota AS
SELECT
    b.id                                   AS bank_id,
    b.name                                 AS bank_name,
    b.code                                 AS bank_code,
    sp.name                                AS plan_name,
    COALESCE(bs.custom_call_limit,       sp.max_calls_per_month)  AS call_limit,
    COALESCE(bs.custom_concurrent_limit, sp.max_concurrent_calls)  AS concurrent_limit,
    COALESCE(bs.custom_user_limit,       sp.max_users)            AS user_limit,
    COALESCE(bs.custom_branch_limit,     sp.max_branches)         AS branch_limit,
    bs.calls_this_cycle,
    bs.cycle_started_at,
    bs.ends_at,
    sp.feature_ai_review,
    sp.feature_multi_branch
FROM banks b
LEFT JOIN bank_subscriptions bs ON bs.bank_id = b.id AND bs.is_active = TRUE AND bs.is_deleted = FALSE
LEFT JOIN subscription_plans sp ON sp.id = bs.plan_id
WHERE b.is_deleted = FALSE;

-- Branch roster with live counts — powers the super-admin drill-down.
CREATE OR REPLACE VIEW v_branch_overview AS
SELECT
    br.id            AS branch_id,
    br.bank_id,
    b.code           AS bank_code,
    b.name           AS bank_name,
    br.branch_code,
    br.name          AS branch_name,
    br.branch_type,
    br.city, br.state, br.ifsc,
    br.is_active,
    (SELECT COUNT(*) FROM bank_users     u WHERE u.branch_id = br.id AND u.is_deleted = FALSE) AS user_count,
    (SELECT COUNT(*) FROM phone_numbers  p WHERE p.branch_id = br.id AND p.is_deleted = FALSE) AS phone_count,
    (SELECT COUNT(*) FROM agent_configs  a WHERE a.branch_id = br.id AND a.is_deleted = FALSE) AS agent_count,
    (SELECT COUNT(*) FROM loan_applications la WHERE la.branch_id = br.id) AS application_count,
    (SELECT COUNT(*) FROM agent_calls    c  WHERE c.branch_id = br.id) AS call_count
FROM bank_branches br
JOIN banks b ON b.id = br.bank_id
WHERE br.is_deleted = FALSE;

-- Flattened effective permissions per user — one lookup for the auth layer.
CREATE OR REPLACE VIEW v_user_effective_permissions AS
SELECT DISTINCT
    ur.user_id,
    ur.user_type,
    ur.bank_id,
    ur.branch_id,
    r.role_code,
    r.scope,
    p.permission_code,
    p.category
FROM user_roles ur
JOIN roles r             ON r.id = ur.role_id AND r.is_active = TRUE AND r.is_deleted = FALSE
JOIN role_permissions rp ON rp.role_id = r.id
JOIN permissions p       ON p.id = rp.permission_id
WHERE ur.is_active = TRUE
  AND (ur.valid_until IS NULL OR ur.valid_until > NOW());


-- ============================================================================
--  §10  SPLIT INTO MIGRATIONS (when approved)
--
--   v26_platform_layer      §1, §2                     new tables only
--   v27_bank_branches       §3.1-3.5, §8.1, §8.6       branches + bank identity
--   v28_rbac                §4, §8.2-8.4               roles + permissions
--   v29_agent_configs       §3.6, §5, §7.2             branch-owned agentic
--   v30_audit_layer         §6                         the five logs
--   v31_operational_branch  §7.1, §7.3-7.5, §8.5, §8.7, §9
--
--  Then, only after backfill is verified on a prod clone:
--   v32_enforce_not_null    bank_id NOT NULL, drop the duplicate status
--                           trigger, drop bank_users' global username unique
--
--  CODE CHANGES REQUIRED ALONGSIDE (schema alone is not enough):
--   1. JWT must carry branch_id (claims today are user_id, role, user_type,
--      bank_id only) and the SSE stream-token must include it too.
--   2. dispatcher._acquire_trunk_from_db must filter by bank_id/branch_id —
--      it currently has no tenant predicate at all.
--   3. The agent's spoken bank name must come from banks.name /
--      agent_configs.display_bank_name, not from agent_type (every
--      non-account_opening call says "ABC Bank" today).
--   4. record_transition() must become the SINGLE writer, take a request
--      context (ip/session/request_id), and be called on vendor disbursement
--      and LRS scoring, which log nothing today.
--   5. Login must write login_audit on every attempt, and stop DELETEing
--      login_attempts on success.
--   6. The three /api/admin/* endpoints with no admin check (main.py:1691,
--      :1721, :2752 — the last one a WRITE) must use get_current_admin.
--   7. Ops endpoints must stop defaulting to "operator sees everything"
--      (agent/state.py:346) and the export endpoints' accidental
--      `bank_id IS NOT DISTINCT FROM NULL` filter must be fixed.
-- ============================================================================
