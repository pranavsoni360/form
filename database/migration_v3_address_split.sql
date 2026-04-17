-- Migration: Split address fields + field_sources + step constraint update
-- Date: 2026-04-10
-- Purpose: Support structured address for lrsAnalysisSummary API (42-field mapping)

-- field_sources JSONB (used in code for PAN/Aadhaar/VoiceCall tracking, never formally migrated)
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS field_sources JSONB DEFAULT '{}'::jsonb;

-- Current address split fields (DigiLocker auto-fills from Aadhaar address object)
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS current_house TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS current_street TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS current_landmark TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS current_locality TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS current_pincode VARCHAR(6);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS current_state_code VARCHAR(10);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS current_city_code VARCHAR(10);

-- Permanent address split fields (mirrors current when "same as current" is checked)
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS permanent_house TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS permanent_street TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS permanent_landmark TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS permanent_locality TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS permanent_pincode VARCHAR(6);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS permanent_state_code VARCHAR(10);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS permanent_city_code VARCHAR(10);

-- Step constraint: expand from 5 to 6 (new Address step between KYC and Occupation)
ALTER TABLE loan_applications DROP CONSTRAINT IF EXISTS chk_step;
ALTER TABLE loan_applications ADD CONSTRAINT chk_step CHECK (current_step BETWEEN 1 AND 6);
