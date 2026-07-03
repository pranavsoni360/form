-- migration_v18_lrs.sql
-- LRS (Loan Recommendation System): isolated scorecard-result table.
-- Reuses existing loan_applications.system_score / system_suggestion / system_reviewed_at
-- (from migration_v2.sql) as the at-a-glance mirror. Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS lrs_scores (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id       UUID NOT NULL UNIQUE REFERENCES loan_applications(id) ON DELETE CASCADE,
    status               VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending|fetching|scored|failed

    -- outputs
    total_score          NUMERIC(6,2),           -- 0-100 (re-weighted if pillars missing)
    decision             VARCHAR(20),            -- approve|refer|reject
    rating               VARCHAR(30),            -- Excellent|Very Good|Good|Fair|Poor
    recommended_amount   NUMERIC(14,2),
    recommended_tenure_m INTEGER,
    recommended_emi      NUMERIC(14,2),
    interest_rate        NUMERIC(6,2),

    -- transparency / audit
    pillar_scores        JSONB,   -- {"credit_bureau":{"score":72,"weight":30,"present":true,"children":{...}}, ...}
    effective_weights    JSONB,   -- pillar weights after re-weighting to 100%
    missing_pillars      TEXT[],  -- e.g. {"bank_statement"}
    incomplete           BOOLEAN DEFAULT FALSE,
    raw_provider_data    JSONB,   -- fetched provider payloads (audit)
    config_version       VARCHAR(20),
    error                TEXT,
    scored_at            TIMESTAMPTZ,
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lrs_scores_app    ON lrs_scores (application_id);
CREATE INDEX IF NOT EXISTS idx_lrs_scores_status ON lrs_scores (status);
