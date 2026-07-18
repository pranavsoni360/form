-- Migration v20: PAN verification retry mechanism
-- Adds attempt counter and mismatch-lock flag to loan_applications.
-- The backend increments pan_verification_attempts on each name-mismatch
-- and sets pan_mismatch_locked = true after the configured maximum (2).

ALTER TABLE loan_applications
  ADD COLUMN IF NOT EXISTS pan_verification_attempts INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pan_mismatch_locked       BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN loan_applications.pan_verification_attempts
  IS 'Number of PAN name-mismatch events recorded (not total API calls)';
COMMENT ON COLUMN loan_applications.pan_mismatch_locked
  IS 'True when the application is locked due to repeated PAN identity mismatches';
