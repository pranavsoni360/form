-- migration_v24_lrs_offer.sql
-- Multi-tenure loan offer (Bajaj-style) + headline max-eligible amount.
--
-- lrs_scores already stores a single recommended amount/tenure/EMI. This adds:
--   offer_options       — JSONB: {max_eligible_amount, foir_used, options:[{tenure_months,
--                          interest_rate, max_amount, recommended_amount, emi, emi_at_max}]}
--   max_eligible_amount — headline "eligible up to Rs X" (best capacity across tenures),
--                          surfaced on the list/detail without parsing the JSONB.
--
-- Idempotent: safe to re-run on every deploy (qa + prod).

ALTER TABLE lrs_scores
    ADD COLUMN IF NOT EXISTS offer_options JSONB;

ALTER TABLE lrs_scores
    ADD COLUMN IF NOT EXISTS max_eligible_amount NUMERIC(14,2);
