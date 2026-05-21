-- ============================================
-- Phase G — Migration V11
-- Vendor portal foundation: vendors, vendor_users, bank<->vendor
-- partnerships, application assignments, settlements
-- ============================================
-- Why: bank-approved loan applications need to be disbursed by a vendor
-- (NBFC / private lender). Today the platform has NO concept of vendors:
-- loan_applications.status terminates at 'approved' / 'disbursed', but
-- there's no record of WHICH external party handled the disbursement.
--
-- Design decisions (locked with Adil 2026-05-21):
--   1. vendors are GLOBAL entities (one row per vendor org, e.g. Bajaj
--      Finance). bank_vendor_partnerships (M:N) controls which banks see
--      which vendors. Realistic + safe for multi-tenant SaaS deploys.
--   2. Vendor CAN reject an assigned app with a reason → returns to bank
--      for reassignment. State machine: pending → accepted → disbursed
--      OR pending → vendor_rejected (bank reassigns).
--   3. 1 settlement row per disbursement (simple). Aggregated/periodic
--      batching can be added later as a view + cron.
--
-- Safe to re-run.

-- 1. ── vendors (global entities, NBFC / private lender orgs) ───────────
CREATE TABLE IF NOT EXISTS vendors (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                TEXT NOT NULL,
    code                TEXT NOT NULL UNIQUE,
    contact_email       TEXT,
    contact_phone       TEXT,
    address             TEXT,
    gstin               TEXT,
    pan_number          TEXT,
    status              TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','suspended','inactive')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendors_status ON vendors(status);
CREATE INDEX IF NOT EXISTS idx_vendors_code   ON vendors(code);

DROP TRIGGER IF EXISTS trg_vendors_updated_at ON vendors;
CREATE TRIGGER trg_vendors_updated_at
    BEFORE UPDATE ON vendors
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- 2. ── vendor_users (login + role within vendor org) ───────────────────
-- Multiple users per vendor (e.g. ops staff + manager). Mirrors bank_users.
CREATE TABLE IF NOT EXISTS vendor_users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_id       UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    full_name       TEXT NOT NULL,
    username        TEXT NOT NULL UNIQUE,
    email           TEXT,
    password_hash   TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'vendor'
                        CHECK (role IN ('vendor','vendor_manager')),
    status          TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','disabled')),
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_users_vendor   ON vendor_users(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_users_username ON vendor_users(username);

DROP TRIGGER IF EXISTS trg_vendor_users_updated_at ON vendor_users;
CREATE TRIGGER trg_vendor_users_updated_at
    BEFORE UPDATE ON vendor_users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- 3. ── bank_vendor_partnerships (M:N: which banks work with which vendors) ─
-- A bank operator only sees vendors in this table for their bank_id (when
-- assigning applications). Admin (super-admin) creates these partnerships.
CREATE TABLE IF NOT EXISTS bank_vendor_partnerships (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id         UUID NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
    vendor_id       UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','suspended','terminated')),
    -- Commercial terms (kept loose — JSON for flexibility now, normalize later)
    commission_pct  NUMERIC(5,2),
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (bank_id, vendor_id)
);

CREATE INDEX IF NOT EXISTS idx_bvp_bank   ON bank_vendor_partnerships(bank_id, status);
CREATE INDEX IF NOT EXISTS idx_bvp_vendor ON bank_vendor_partnerships(vendor_id, status);

DROP TRIGGER IF EXISTS trg_bvp_updated_at ON bank_vendor_partnerships;
CREATE TRIGGER trg_bvp_updated_at
    BEFORE UPDATE ON bank_vendor_partnerships
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- 4. ── application_vendor_assignments (1:1 with loan_applications) ─────
-- State machine:
--   pending          → vendor hasn't acted yet (just assigned)
--   accepted         → vendor accepted, working on disbursement
--   disbursed        → vendor confirmed payout (terminal — also triggers settlement row)
--   vendor_rejected  → vendor pushed back (terminal — bank reassigns)
--   withdrawn        → bank cancelled assignment (terminal — bank reassigns or closes app)
--
-- UNIQUE on application_id means one active assignment at a time. To
-- reassign, the previous row must move to a terminal state — then a NEW
-- row is created for the new vendor. (We do NOT mutate the FK on the
-- existing row; an audit trail of who-was-assigned-when matters.)
--
-- Wait — if UNIQUE prevents 2 rows for same app, reassignment fails. Fix:
-- UNIQUE only on (application_id) WHERE status IN ('pending','accepted').
-- Postgres partial unique index handles this elegantly.
CREATE TABLE IF NOT EXISTS application_vendor_assignments (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id      UUID NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,
    vendor_id           UUID NOT NULL REFERENCES vendors(id),
    bank_id             UUID NOT NULL REFERENCES banks(id),  -- denormalized for fast bank-scoped queries
    assigned_by_type    TEXT NOT NULL CHECK (assigned_by_type IN ('admin','bank_user','system')),
    assigned_by_id      UUID,
    assigned_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status              TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','accepted','disbursed','vendor_rejected','withdrawn')),
    notes               TEXT,
    -- Disbursement details (populated when status → 'disbursed')
    disbursed_amount    NUMERIC(15,2),
    disbursed_at        TIMESTAMPTZ,
    disbursement_ref    TEXT,
    -- Rejection details (populated when status → 'vendor_rejected')
    rejected_at         TIMESTAMPTZ,
    rejection_reason    TEXT,
    -- Withdrawal details (populated when status → 'withdrawn')
    withdrawn_at        TIMESTAMPTZ,
    withdrawn_by_id     UUID,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial unique: only one ACTIVE assignment per app at a time. Terminal
-- rows (disbursed/rejected/withdrawn) are excluded so reassignment works.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_assignment_per_app
    ON application_vendor_assignments(application_id)
    WHERE status IN ('pending','accepted');

CREATE INDEX IF NOT EXISTS idx_ava_vendor_status   ON application_vendor_assignments(vendor_id, status);
CREATE INDEX IF NOT EXISTS idx_ava_bank_status     ON application_vendor_assignments(bank_id, status);
CREATE INDEX IF NOT EXISTS idx_ava_application     ON application_vendor_assignments(application_id);
CREATE INDEX IF NOT EXISTS idx_ava_assigned_at     ON application_vendor_assignments(assigned_at DESC);

DROP TRIGGER IF EXISTS trg_ava_updated_at ON application_vendor_assignments;
CREATE TRIGGER trg_ava_updated_at
    BEFORE UPDATE ON application_vendor_assignments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- 5. ── vendor_settlements (1 per disbursement, simple model) ───────────
-- Auto-created by app code (or a follow-on trigger in v12) when an
-- assignment transitions to 'disbursed'. Settlement = money owed back to
-- bank from vendor for the disbursement. status tracks payment lifecycle.
CREATE TABLE IF NOT EXISTS vendor_settlements (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_id           UUID NOT NULL REFERENCES vendors(id),
    bank_id             UUID NOT NULL REFERENCES banks(id),
    assignment_id       UUID NOT NULL REFERENCES application_vendor_assignments(id),
    application_id      UUID NOT NULL REFERENCES loan_applications(id),
    amount              NUMERIC(15,2) NOT NULL,
    -- Commission split based on bank_vendor_partnerships.commission_pct
    -- (computed once + snapshotted so retroactive partnership edits don't
    -- mutate historical settlement amounts)
    commission_pct      NUMERIC(5,2),
    commission_amount   NUMERIC(15,2),
    bank_payout         NUMERIC(15,2),  -- amount - commission_amount (sanity check)
    status              TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','paid','failed','disputed')),
    payment_ref         TEXT,
    settled_at          TIMESTAMPTZ,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settlements_vendor_status ON vendor_settlements(vendor_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_settlements_bank_status   ON vendor_settlements(bank_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_settlements_assignment    ON vendor_settlements(assignment_id);

DROP TRIGGER IF EXISTS trg_settlements_updated_at ON vendor_settlements;
CREATE TRIGGER trg_settlements_updated_at
    BEFORE UPDATE ON vendor_settlements
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- 6. ── Optional: status_transitions logging for assignments + settlements ─
-- We don't extend status_transitions (which is loan_application-scoped) to
-- vendor tables — assignment_id is the audit record itself (each row IS a
-- status snapshot). Settlements are similar. If forensic audit becomes a
-- need, add a vendor_status_transitions table in v12.


-- 7. ── No seed data ─────────────────────────────────────────────────────
-- Admin creates real vendor rows via /api/admin/vendors. No PUSAD-specific
-- seeding here (vendor relationships are per-bank business decisions, not
-- baked into the migration). Cleaner audit for "when did vendor X join".
