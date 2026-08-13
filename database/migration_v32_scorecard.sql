-- ============================================================================
--  migration_v32_scorecard.sql   (task #4 — bank-editable versioned scorecard)
--
--  Today the credit scorecard is ONE global JSONB blob (lrs_scorecard_config,
--  single row, no bank, no version, no history) that the LRS engine reads. The
--  Scorecard dashboard edits pillars/params/bands/knockouts/thresholds and
--  offers Import/Export JSON — i.e. it treats the scorecard AS a versioned JSON
--  document. So the right model is versioned JSON PER BANK (+ product), not a
--  parallel relational rewrite of the engine:
--
--    loan_products        per-bank product catalogue (seed 1 default each)
--    scorecard_versions   per (bank, product): the full scorecard as jsonb,
--                         with version history, one 'live' at a time, lineage
--                         for compare, and publish metadata.
--
--  "Saving takes effect for new applications; pending files re-score on the new
--  version; decided files keep the version they were scored on" — supported by
--  lrs_scores.scorecard_version_id (added here) pinning each score to a version.
--
--  Every bank is seeded a v1 = 'live' copy of the current platform-standard
--  scorecard, so nothing changes for scoring until a bank edits its own.
--  Additive + idempotent. Reuses v26 helper update_updated_at_column.
-- ============================================================================

-- ── 1. loan_products (product-aware from the start; single product seeded) ───
CREATE TABLE IF NOT EXISTS loan_products (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bank_id       UUID NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
    product_code  VARCHAR(30) NOT NULL,
    name          VARCHAR(80) NOT NULL,
    description   TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    is_deleted    BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at    TIMESTAMPTZ, deleted_by UUID, delete_reason TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_by UUID,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_by UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_loan_products_code
    ON loan_products (bank_id, UPPER(product_code)) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_loan_products_bank ON loan_products (bank_id) WHERE is_deleted = FALSE;
DROP TRIGGER IF EXISTS trg_loan_products_upd ON loan_products;
CREATE TRIGGER trg_loan_products_upd BEFORE UPDATE ON loan_products
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- one default Personal product per bank (single-product now, catalogue-ready)
INSERT INTO loan_products (bank_id, product_code, name, description)
SELECT b.id, 'PERSONAL', 'Personal Loan', 'Default personal/consumer product'
  FROM banks b
 WHERE NOT EXISTS (
     SELECT 1 FROM loan_products p
      WHERE p.bank_id = b.id AND UPPER(p.product_code) = 'PERSONAL' AND p.is_deleted = FALSE
 );

-- ── 2. scorecard_versions — versioned, bank-editable scorecard ───────────────
CREATE TABLE IF NOT EXISTS scorecard_versions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bank_id        UUID NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
    product_id     UUID REFERENCES loan_products(id) ON DELETE CASCADE,  -- NULL = all products
    version_number INTEGER NOT NULL,
    config         JSONB NOT NULL,          -- pillars, parameters, bands, knockouts,
                                            -- decision thresholds, offer/rate bands
    status         VARCHAR(20) NOT NULL DEFAULT 'draft',   -- draft|live|archived
    is_active      BOOLEAN NOT NULL DEFAULT FALSE,          -- the one currently scoring
    based_on_version INTEGER,               -- lineage, for "compare versions"
    change_summary TEXT,
    published_by   UUID, published_at TIMESTAMPTZ,
    is_deleted     BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at     TIMESTAMPTZ, deleted_by UUID, delete_reason TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_by UUID,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_by UUID
);
ALTER TABLE scorecard_versions DROP CONSTRAINT IF EXISTS chk_scorecard_status;
ALTER TABLE scorecard_versions ADD CONSTRAINT chk_scorecard_status
    CHECK (status IN ('draft','live','archived'));

-- version numbers are unique per (bank, product); NULL product treated as one slot
CREATE UNIQUE INDEX IF NOT EXISTS uq_scorecard_version_num
    ON scorecard_versions (bank_id, product_id, version_number) NULLS NOT DISTINCT;
-- exactly one live/active scorecard per (bank, product)
CREATE UNIQUE INDEX IF NOT EXISTS uq_scorecard_one_active
    ON scorecard_versions (bank_id, product_id) NULLS NOT DISTINCT
    WHERE is_active = TRUE AND is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_scorecard_bank ON scorecard_versions (bank_id, product_id);
DROP TRIGGER IF EXISTS trg_scorecard_versions_upd ON scorecard_versions;
CREATE TRIGGER trg_scorecard_versions_upd BEFORE UPDATE ON scorecard_versions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- seed v1 = live per bank, copied from the current platform-standard config, so
-- scoring behaviour is identical until a bank edits its own scorecard.
INSERT INTO scorecard_versions (bank_id, product_id, version_number, config, status, is_active, change_summary, published_at)
SELECT b.id, NULL, 1,
       COALESCE((SELECT config FROM lrs_scorecard_config ORDER BY id LIMIT 1),
                '{"note":"empty — configure via the scorecard screen"}'::jsonb),
       'live', TRUE, 'Seeded from platform standard scorecard', NOW()
  FROM banks b
 WHERE NOT EXISTS (
     SELECT 1 FROM scorecard_versions sv WHERE sv.bank_id = b.id AND sv.product_id IS NULL
 );

-- ── 3. pin each score to the version that produced it ───────────────────────
ALTER TABLE lrs_scores
    ADD COLUMN IF NOT EXISTS scorecard_version_id UUID REFERENCES scorecard_versions(id);
CREATE INDEX IF NOT EXISTS idx_lrs_scores_version ON lrs_scores (scorecard_version_id);

-- loan_applications: which scorecard version scored this file (fast lookup for
-- the "decided files keep their version" rule + the application detail screen).
ALTER TABLE loan_applications
    ADD COLUMN IF NOT EXISTS scored_on_version INTEGER;
