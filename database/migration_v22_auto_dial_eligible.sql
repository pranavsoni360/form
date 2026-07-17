-- migration_v22_auto_dial_eligible.sql
-- Per-number "auto-dial" flag for the dispatcher.
--
-- A number with auto_dial_eligible = FALSE is never chosen by the dispatcher's
-- automatic least-loaded pick, but stays fully usable when the operator picks
-- it explicitly in the Batch → "From number" dropdown (the preferred_phone_id
-- path ignores this flag). The number also stays status='active'.
--
-- Use case: the Twilio US caller-ID (+15076046329) must not auto-dial Indian
-- customers (wrong +1 caller-ID + international cost), but remains available
-- for deliberate US campaigns. Vobiz (+918071583503) stays the auto default.
--
-- Idempotent: safe to re-run on every deploy (qa + prod).

ALTER TABLE phone_numbers
    ADD COLUMN IF NOT EXISTS auto_dial_eligible BOOLEAN NOT NULL DEFAULT TRUE;

-- Twilio US caller-ID → manual-only.
UPDATE phone_numbers
   SET auto_dial_eligible = FALSE
 WHERE phone_number = '+15076046329';
