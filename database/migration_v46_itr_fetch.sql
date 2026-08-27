-- ============================================================================
-- v46 — derived ITR income from the customer-facing "Generate" button
--
-- VG's ITR_Advance returns a full tax extract: balance sheet, P&L, presumptive
-- income sections, cash balances. We store NONE of that. These four columns are
-- the only things the scorecard can use, and keeping the raw extract would mean
-- holding a second copy of the applicant's complete tax position for no benefit.
--
-- What is deliberately absent from this migration:
--   * the income-tax portal username — not needed after the call
--   * the income-tax portal PASSWORD — never persisted anywhere, by design
--     (see backend/lrs/itr_routes.py; it lives only as a local variable for the
--     duration of one outbound request)
--
-- itr_income_basis records WHICH figure the number came from
-- (presumptive_44ADA / presumptive_44AD / total_income / profit_before_tax),
-- because "₹3.9L annual" means different things depending on its source and an
-- officer reviewing the file needs to know which one they are looking at.
--
-- Numbered v46: v42 and v44 each already have two files. The runner tracks by
-- filename and breaks ties alphabetically so those pairs are harmless, but the
-- sequence should stop colliding.
-- ============================================================================

ALTER TABLE loan_applications
    ADD COLUMN IF NOT EXISTS itr_income_annual  NUMERIC(14,2),
    ADD COLUMN IF NOT EXISTS itr_income_basis   TEXT,
    ADD COLUMN IF NOT EXISTS itr_financial_year TEXT,
    ADD COLUMN IF NOT EXISTS itr_fetched_at     TIMESTAMPTZ;

-- Constrain the basis to the derivations itr_routes.derive_itr_income emits, so
-- a future change there cannot quietly write an unrecognised label. NULL stays
-- valid: rows predating this migration have no basis, and saying so honestly is
-- better than defaulting them to a source they never had.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'loan_applications_itr_basis_check'
    ) THEN
        ALTER TABLE loan_applications
            ADD CONSTRAINT loan_applications_itr_basis_check
            CHECK (itr_income_basis IS NULL OR itr_income_basis IN (
                'presumptive_44ADA', 'presumptive_44AD',
                'total_income', 'profit_before_tax'
            ));
    END IF;
END $$;
