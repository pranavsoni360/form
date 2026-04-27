-- ============================================================
-- Migration v5 — V2 → V3 unified-identity + vendors
--
-- Forward-only. Idempotent (every DDL guarded by IF NOT EXISTS / DO
-- blocks; every data INSERT uses ON CONFLICT DO NOTHING). Wrapped
-- in a single transaction so a partial failure rolls back cleanly.
--
-- Keeps admin_users / bank_users tables intact for one-week rollback
-- safety. They are dropped in migration_v6_drop_legacy.sql once V3
-- is proven stable.
--
-- Field source notes for runtime decisions made when writing this:
--   * admin_users on prod has columns: id, email, full_name,
--     password_hash, role, is_active, created_at, last_login_at.
--     NO username column. So we synthesize username from email.
--   * bank_users on prod has: id, username, password_hash, full_name,
--     email, role, bank_id, is_active, created_at, last_login_at.
--   * banks on prod already has the `code` column NOT NULL so we
--     don't need to backfill, but we add IF NOT EXISTS for safety
--     in case a fresh database lacks it.
-- ============================================================
BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- Phase A: new tables (vendors first; users.vendor_id FKs into it)
-- ============================================================

CREATE TABLE IF NOT EXISTS vendors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id UUID NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(50) NOT NULL,
    category VARCHAR(100),
    contact_name VARCHAR(255),
    contact_email VARCHAR(255),
    contact_phone VARCHAR(20),
    address TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive')),
    created_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (bank_id, code)
);
CREATE INDEX IF NOT EXISTS idx_vendors_bank   ON vendors(bank_id);
CREATE INDEX IF NOT EXISTS idx_vendors_status ON vendors(status);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    full_name VARCHAR(255),
    email VARCHAR(255),
    phone VARCHAR(20),
    role VARCHAR(20) NOT NULL
        CHECK (role IN ('admin', 'bank_user', 'vendor_user', 'customer')),
    bank_id UUID REFERENCES banks(id) ON DELETE CASCADE,
    vendor_id UUID REFERENCES vendors(id) ON DELETE CASCADE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_login_at TIMESTAMPTZ,
    CONSTRAINT chk_user_scope CHECK (
        (role = 'admin'        AND bank_id IS NULL     AND vendor_id IS NULL) OR
        (role = 'bank_user'    AND bank_id IS NOT NULL AND vendor_id IS NULL) OR
        (role = 'vendor_user'  AND bank_id IS NOT NULL AND vendor_id IS NOT NULL) OR
        (role = 'customer'     AND bank_id IS NULL     AND vendor_id IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_bank   ON users(bank_id);
CREATE INDEX IF NOT EXISTS idx_users_vendor ON users(vendor_id);
CREATE INDEX IF NOT EXISTS idx_users_phone  ON users(phone);

-- Deferred FK on vendors.created_by → users.id (now that users exists)
DO $$ BEGIN
    ALTER TABLE vendors
        ADD CONSTRAINT fk_vendors_created_by
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ============================================================
-- Phase B: data migration — admin_users + bank_users → users
-- Preserve UUIDs so all FK references (e.g. loan_applications.reviewed_by,
-- agent_calls.initiated_by) survive the migration without backfill.
-- ============================================================

-- admin_users → users.role='admin'
-- admin_users has no `username` column on prod, so we synthesize one
-- from email (preferred) or fall back to 'admin_'||id.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_name = 'admin_users') THEN
        INSERT INTO users (id, username, password_hash, full_name, email,
                           role, bank_id, vendor_id, is_active,
                           created_at, last_login_at)
        SELECT id,
               -- Username: email if present, else 'admin_<uuid-prefix>'
               COALESCE(NULLIF(email, ''), 'admin_' || substr(id::text, 1, 8)),
               password_hash,
               COALESCE(full_name, 'Administrator'),
               email,
               'admin',
               NULL, NULL,
               COALESCE(is_active, TRUE),
               COALESCE(created_at, NOW()),
               last_login_at
          FROM admin_users
        ON CONFLICT (id) DO NOTHING;
    END IF;
END $$;

-- bank_users → users.role='bank_user'
-- bank_users has its own username column on prod; we use it.
-- bank_users.role on prod may be 'officer'/'supervisor' (V2 distinction);
-- collapse all to 'bank_user' for V3.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_name = 'bank_users') THEN
        INSERT INTO users (id, username, password_hash, full_name, email, phone,
                           role, bank_id, vendor_id, is_active,
                           created_at, last_login_at)
        SELECT bu.id,
               COALESCE(NULLIF(bu.username, ''), bu.email,
                        'bank_' || substr(bu.id::text, 1, 8)),
               bu.password_hash,
               COALESCE(bu.full_name, bu.username, 'Bank User'),
               bu.email,
               NULL,
               'bank_user',
               bu.bank_id,
               NULL,
               COALESCE(bu.is_active, TRUE),
               COALESCE(bu.created_at, NOW()),
               bu.last_login_at
          FROM bank_users bu
        ON CONFLICT (id) DO NOTHING;
    END IF;
END $$;

-- Username collision rescue: if both tables had a row whose synthesized
-- username collided with another, suffix the non-admin one with '_bank'.
DO $$ DECLARE rec RECORD; BEGIN
    FOR rec IN
        SELECT u1.id, u1.username
          FROM users u1
          JOIN users u2 ON u1.username = u2.username AND u1.id <> u2.id
         WHERE u1.role <> 'admin'
    LOOP
        UPDATE users
           SET username = rec.username || '_bank'
         WHERE id = rec.id
           AND NOT EXISTS (SELECT 1 FROM users
                           WHERE username = rec.username || '_bank');
    END LOOP;
END $$;


-- ============================================================
-- Phase C: add missing V3 columns to existing tables
-- ============================================================

ALTER TABLE banks
    ADD COLUMN IF NOT EXISTS code          VARCHAR(50),
    ADD COLUMN IF NOT EXISTS vendor_limit  INTEGER NOT NULL DEFAULT 5,
    ADD COLUMN IF NOT EXISTS logo_url      TEXT,
    ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255),
    ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(20),
    ADD COLUMN IF NOT EXISTS address       TEXT,
    ADD COLUMN IF NOT EXISTS status        VARCHAR(20) NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ DEFAULT NOW();

-- Backfill banks.code via slug if any row has NULL/empty code.
-- (Prod already has NOT NULL code, so this is a safety net for
-- fresh / partially-migrated databases.)
UPDATE banks
   SET code = LOWER(REGEXP_REPLACE(name, '[^a-zA-Z0-9]+', '_', 'g'))
 WHERE code IS NULL OR code = '';

-- Ensure UNIQUE on banks.code (idempotent — the constraint name follows
-- Postgres' default if it was added by a previous CREATE TABLE).
DO $$ BEGIN
    ALTER TABLE banks ADD CONSTRAINT banks_code_unique UNIQUE (code);
EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN duplicate_table  THEN NULL;
    WHEN unique_violation THEN
        RAISE NOTICE 'banks_code_unique skipped: existing rows have duplicate codes -- inspect manually';
END $$;

ALTER TABLE form_tokens
    ADD COLUMN IF NOT EXISTS bank_id   UUID REFERENCES banks(id),
    ADD COLUMN IF NOT EXISTS vendor_id UUID REFERENCES vendors(id);

ALTER TABLE loan_applications
    ADD COLUMN IF NOT EXISTS bank_id                  UUID REFERENCES banks(id),
    ADD COLUMN IF NOT EXISTS vendor_id                UUID REFERENCES vendors(id),
    ADD COLUMN IF NOT EXISTS initiated_by             UUID,
    ADD COLUMN IF NOT EXISTS agent_call_id            UUID,
    ADD COLUMN IF NOT EXISTS field_sources            JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS system_suggestion        VARCHAR(20),
    ADD COLUMN IF NOT EXISTS system_suggestion_reason TEXT,
    ADD COLUMN IF NOT EXISTS system_score             DECIMAL(5,2),
    ADD COLUMN IF NOT EXISTS system_reviewed_at       TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS documents_requested_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS documents_submitted_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS approved_at              TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS disbursed_at             TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS pan_name                 TEXT,
    ADD COLUMN IF NOT EXISTS aadhaar_name             TEXT,
    ADD COLUMN IF NOT EXISTS aadhaar_dob              TEXT,
    ADD COLUMN IF NOT EXISTS aadhaar_gender           VARCHAR(20),
    ADD COLUMN IF NOT EXISTS aadhaar_address          TEXT,
    ADD COLUMN IF NOT EXISTS aadhaar_photo_b64        TEXT,
    ADD COLUMN IF NOT EXISTS digilocker_request_id    TEXT,
    ADD COLUMN IF NOT EXISTS digilocker_uri           TEXT;

-- Add system_suggestion CHECK if not present
DO $$ BEGIN
    ALTER TABLE loan_applications
        ADD CONSTRAINT chk_loan_app_system_sugg
        CHECK (system_suggestion IN ('approve', 'deny', 'review')
               OR system_suggestion IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Deferred FKs on loan_applications.{initiated_by, reviewed_by, agent_call_id}
DO $$ BEGIN
    ALTER TABLE loan_applications
        ADD CONSTRAINT fk_loan_apps_initiated_by
        FOREIGN KEY (initiated_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE loan_applications
        ADD CONSTRAINT fk_loan_apps_reviewed_by
        FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
         WHEN duplicate_table  THEN NULL; END $$;

-- agent_batches V3 columns (covers cases where v4_batch_progress hasn't run)
ALTER TABLE agent_batches
    ADD COLUMN IF NOT EXISTS bank_id        UUID REFERENCES banks(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS vendor_id      UUID REFERENCES vendors(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS initiated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS uploaded_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS max_concurrent INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS progress       JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS cancelled_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS error          TEXT;

ALTER TABLE agent_calls
    ADD COLUMN IF NOT EXISTS bank_id        UUID REFERENCES banks(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS vendor_id      UUID REFERENCES vendors(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS initiated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES loan_applications(id) ON DELETE SET NULL;

-- Cleanup orphaned references BEFORE adding FK constraints. Real-world data
-- in prod has stray agent_call_ids pointing at rows that never landed in
-- agent_calls (e.g., dispatches stolen by a different worker that posted to
-- a different backend, or stale test data). Without this nullify pass the
-- FK ADD would fail on existing data.
UPDATE loan_applications la
   SET agent_call_id = NULL
 WHERE agent_call_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM agent_calls ac WHERE ac.id = la.agent_call_id);

UPDATE loan_applications la
   SET reviewed_by = NULL
 WHERE reviewed_by IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = la.reviewed_by);

UPDATE agent_calls ac
   SET application_id = NULL
 WHERE application_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM loan_applications la WHERE la.id = ac.application_id);

-- Deferred FK on loan_applications.agent_call_id (now that agent_calls exists)
DO $$ BEGIN
    ALTER TABLE loan_applications
        ADD CONSTRAINT fk_loan_apps_agent_call
        FOREIGN KEY (agent_call_id) REFERENCES agent_calls(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- agent_system_config: ensure exists + emergency_stop default row
CREATE TABLE IF NOT EXISTS agent_system_config (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO agent_system_config (key, value)
    VALUES ('emergency_stop', 'false')
    ON CONFLICT (key) DO NOTHING;


-- ============================================================
-- Phase D: indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_loan_apps_bank      ON loan_applications(bank_id);
CREATE INDEX IF NOT EXISTS idx_loan_apps_vendor    ON loan_applications(vendor_id);
CREATE INDEX IF NOT EXISTS idx_form_tokens_bank    ON form_tokens(bank_id);
CREATE INDEX IF NOT EXISTS idx_agent_calls_bank    ON agent_calls(bank_id);
CREATE INDEX IF NOT EXISTS idx_agent_calls_vendor  ON agent_calls(vendor_id);
CREATE INDEX IF NOT EXISTS idx_agent_batches_bank  ON agent_batches(bank_id);
CREATE INDEX IF NOT EXISTS idx_agent_batches_vendor ON agent_batches(vendor_id);


-- ============================================================
-- Phase E: backfills
-- ============================================================

-- loan_applications.bank_id from form_tokens (when NULL)
UPDATE loan_applications la
   SET bank_id = ft.bank_id
  FROM form_tokens ft
 WHERE la.token_id = ft.id
   AND la.bank_id IS NULL
   AND ft.bank_id IS NOT NULL;

-- form_tokens.bank_id from associated loan_application (other direction)
UPDATE form_tokens ft
   SET bank_id = la.bank_id
  FROM loan_applications la
 WHERE la.token_id = ft.id
   AND ft.bank_id IS NULL
   AND la.bank_id IS NOT NULL;


-- ============================================================
-- Phase F: keep V2 tables for rollback
-- DO NOT DROP admin_users / bank_users in this migration.
-- They remain readable for one week, then drop in v6.
-- ============================================================

COMMIT;

-- Post-flight sanity (RAISE NOTICE; non-blocking, runs outside transaction)
DO $$
DECLARE
    u_count INT;
    v_count INT;
    b_count INT;
    bu_count INT;
    au_count INT;
BEGIN
    SELECT COUNT(*) INTO u_count FROM users;
    SELECT COUNT(*) INTO v_count FROM vendors;
    SELECT COUNT(*) INTO b_count FROM banks;

    -- Legacy tables for comparison (skip silently if they don't exist)
    BEGIN
        EXECUTE 'SELECT COUNT(*) FROM bank_users'  INTO bu_count;
    EXCEPTION WHEN undefined_table THEN bu_count := -1; END;
    BEGIN
        EXECUTE 'SELECT COUNT(*) FROM admin_users' INTO au_count;
    EXCEPTION WHEN undefined_table THEN au_count := -1; END;

    RAISE NOTICE 'migration_v5 complete: users=% vendors=% banks=% (legacy: bank_users=% admin_users=%)',
                 u_count, v_count, b_count, bu_count, au_count;
END $$;
