-- ============================================
-- Migration V12 — banks.vendor_limit
-- ============================================
-- Commercial constraint for multi-bank SaaS: each bank gets a cap on how
-- many active vendor partnerships it can hold (negotiated per contract).
-- Without this, any bank could hog the vendor pool.
--
-- Decision: default 10 (matches the typical lower-tier plan in the
--   conversation with Adil 2026-05-21). Super-admin can edit per bank.
-- Nullable=NOT NULL DEFAULT 10 so existing rows backfill safely without
-- requiring a manual update step.
--
-- Enforcement lives in backend/routers/vendors.py — POST /api/admin/partnerships
-- counts active partnerships and rejects 409 if at the cap. The schema
-- change here is purely the data backing; we deliberately do NOT add a
-- CHECK constraint that joins back to bank_vendor_partnerships because
-- (a) Postgres can't express that cross-table check natively without a
-- trigger, and (b) doing it in app code keeps the error message friendly.
--
-- Safe to re-run.

ALTER TABLE banks
    ADD COLUMN IF NOT EXISTS vendor_limit INTEGER NOT NULL DEFAULT 10;

COMMENT ON COLUMN banks.vendor_limit IS
    'Maximum number of active bank_vendor_partnerships this bank may hold. '
    'Enforced in app code (POST /api/admin/partnerships). Default 10.';
