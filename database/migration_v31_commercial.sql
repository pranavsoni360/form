-- ============================================================================
--  migration_v31_commercial.sql   (task #3 — the prepaid billing layer)
--
--  The dashboards run on a prepaid model: banks top up a credit line, each call
--  meters minutes and debits the wallet, calling pauses at zero, a monthly
--  invoice reconciles. Today only simple caches exist (banks.credit_balance /
--  minute_quota, added by the bank-admin work). This adds the real financial
--  layer WITHOUT breaking those:
--
--    rate_cards            named per-minute price plans
--    credit_ledger         append-only wallet — every top-up/debit, running bal
--    usage_records         per-call minute metering (what drives debits)
--    invoices + lines      monthly cycle, GST, composition by head
--
--  banks.credit_balance stays as the fast-read balance the dashboards use; the
--  ledger is now the source of truth and keeps that column in sync via trigger.
--  Additive + idempotent. Reuses v26 helpers (update_updated_at_column,
--  fn_audit_append_only).
-- ============================================================================

-- ── 1. rate_cards ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rate_cards (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(80)  NOT NULL,
    card_code       VARCHAR(30)  NOT NULL,
    rate_per_minute NUMERIC(10,2) NOT NULL CHECK (rate_per_minute >= 0),
    currency        VARCHAR(3)   NOT NULL DEFAULT 'INR',
    min_volume      INTEGER,                       -- minutes/mo to qualify (volume tiers)
    effective_from  DATE         NOT NULL DEFAULT CURRENT_DATE,
    effective_to    DATE,
    description     TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    is_deleted      BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at      TIMESTAMPTZ, deleted_by UUID, delete_reason TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_by UUID,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_by UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rate_cards_code
    ON rate_cards (UPPER(card_code)) WHERE is_deleted = FALSE;
DROP TRIGGER IF EXISTS trg_rate_cards_upd ON rate_cards;
CREATE TRIGGER trg_rate_cards_upd BEFORE UPDATE ON rate_cards
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- The three cards the provisioning wizard offers.
INSERT INTO rate_cards (name, card_code, rate_per_minute, min_volume, description) VALUES
    ('Co-op standard', 'COOP_STD',  4.20, NULL,  'Standard cooperative-bank rate'),
    ('Co-op pilot',    'COOP_PILOT',5.00, NULL,  'Pilot / onboarding rate'),
    ('Volume 50k+',    'VOL_50K',   3.60, 50000, 'High-volume rate, 50k+ minutes/month')
ON CONFLICT DO NOTHING;

-- ── 2. banks: commercial columns the wallet/billing need (additive) ──────────
ALTER TABLE banks
    ADD COLUMN IF NOT EXISTS rate_card_id           UUID,
    ADD COLUMN IF NOT EXISTS overage_billing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS low_balance_threshold  NUMERIC(12,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS auto_topup_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS auto_topup_amount      NUMERIC(12,2),
    ADD COLUMN IF NOT EXISTS minutes_used_cycle     NUMERIC(12,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS calling_paused         BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE banks DROP CONSTRAINT IF EXISTS fk_banks_rate_card;
ALTER TABLE banks ADD CONSTRAINT fk_banks_rate_card
    FOREIGN KEY (rate_card_id) REFERENCES rate_cards(id) ON DELETE SET NULL;

-- ── 3. credit_ledger — append-only wallet, running balance, balance cache ────
CREATE TABLE IF NOT EXISTS credit_ledger (
    id             BIGSERIAL PRIMARY KEY,
    bank_id        UUID NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
    entry_type     VARCHAR(20) NOT NULL,            -- opening|topup|debit|adjustment|refund
    amount         NUMERIC(14,2) NOT NULL,          -- signed: +credit, -debit
    balance_after  NUMERIC(14,2) NOT NULL,          -- set by trigger
    currency       VARCHAR(3) NOT NULL DEFAULT 'INR',
    reference      VARCHAR(120),                    -- UTR / cheque / adjustment ref
    note           TEXT,
    related_call_id  UUID,                          -- for per-call debits
    related_invoice_id UUID,
    actor_type     VARCHAR(20),                     -- platform_admin|system|bank_user
    actor_id       UUID,
    actor_username VARCHAR(120),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS chk_credit_ledger_type;
ALTER TABLE credit_ledger ADD CONSTRAINT chk_credit_ledger_type
    CHECK (entry_type IN ('opening','topup','debit','adjustment','refund'));
CREATE INDEX IF NOT EXISTS idx_credit_ledger_bank ON credit_ledger (bank_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_call ON credit_ledger (related_call_id) WHERE related_call_id IS NOT NULL;

-- BEFORE INSERT: lock the bank row, compute running balance_after (serialised).
CREATE OR REPLACE FUNCTION fn_credit_ledger_before() RETURNS trigger AS $$
DECLARE cur NUMERIC(14,2);
BEGIN
    SELECT COALESCE(credit_balance, 0) INTO cur FROM banks WHERE id = NEW.bank_id FOR UPDATE;
    NEW.balance_after := cur + NEW.amount;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_credit_ledger_before ON credit_ledger;
CREATE TRIGGER trg_credit_ledger_before BEFORE INSERT ON credit_ledger
    FOR EACH ROW EXECUTE FUNCTION fn_credit_ledger_before();

-- AFTER INSERT: sync the fast-read cache the dashboards use + auto-pause at <=0.
CREATE OR REPLACE FUNCTION fn_credit_ledger_after() RETURNS trigger AS $$
BEGIN
    UPDATE banks
       SET credit_balance = NEW.balance_after,
           calling_paused = (NEW.balance_after <= 0)
     WHERE id = NEW.bank_id;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_credit_ledger_after ON credit_ledger;
CREATE TRIGGER trg_credit_ledger_after AFTER INSERT ON credit_ledger
    FOR EACH ROW EXECUTE FUNCTION fn_credit_ledger_after();

-- Append-only: no UPDATE/DELETE on a financial ledger.
DROP TRIGGER IF EXISTS trg_credit_ledger_append_only ON credit_ledger;
CREATE TRIGGER trg_credit_ledger_append_only
    BEFORE UPDATE OR DELETE ON credit_ledger
    FOR EACH ROW EXECUTE FUNCTION fn_audit_append_only();

-- ── 4. usage_records — per-call minute metering (drives the debits) ──────────
CREATE TABLE IF NOT EXISTS usage_records (
    id               BIGSERIAL PRIMARY KEY,
    bank_id          UUID NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
    branch_id        UUID,
    call_id          UUID,                          -- agent_calls.id
    billable_seconds INTEGER NOT NULL DEFAULT 0,
    billable_minutes NUMERIC(10,2) NOT NULL DEFAULT 0,
    rate_per_minute  NUMERIC(10,2) NOT NULL DEFAULT 0,   -- snapshot at bill time
    amount           NUMERIC(12,2) NOT NULL DEFAULT 0,   -- billable_minutes * rate
    currency         VARCHAR(3) NOT NULL DEFAULT 'INR',
    -- optional cost breakdown for the "cost by component" card
    cost_stt         NUMERIC(10,4), cost_llm NUMERIC(10,4),
    cost_tts         NUMERIC(10,4), cost_telephony NUMERIC(10,4),
    billing_period   DATE NOT NULL DEFAULT date_trunc('month', CURRENT_DATE)::date,
    invoice_id       UUID,                          -- set when invoiced
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_usage_records_call
    ON usage_records (call_id) WHERE call_id IS NOT NULL;   -- one bill per call
CREATE INDEX IF NOT EXISTS idx_usage_records_bank_period
    ON usage_records (bank_id, billing_period);
CREATE INDEX IF NOT EXISTS idx_usage_records_uninvoiced
    ON usage_records (bank_id, billing_period) WHERE invoice_id IS NULL;

-- ── 5. invoices + line items ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number VARCHAR(40) NOT NULL,
    bank_id        UUID NOT NULL REFERENCES banks(id) ON DELETE RESTRICT,
    period_start   DATE NOT NULL,
    period_end     DATE NOT NULL,
    rate_card_id   UUID REFERENCES rate_cards(id),
    currency       VARCHAR(3) NOT NULL DEFAULT 'INR',
    subtotal       NUMERIC(14,2) NOT NULL DEFAULT 0,
    gst_rate       NUMERIC(5,2)  NOT NULL DEFAULT 18.00,
    gst_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
    total          NUMERIC(14,2) NOT NULL DEFAULT 0,
    status         VARCHAR(20) NOT NULL DEFAULT 'draft',
    issued_at      TIMESTAMPTZ, due_date DATE, paid_at TIMESTAMPTZ,
    notes          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_by UUID,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_by UUID
);
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS chk_invoices_status;
ALTER TABLE invoices ADD CONSTRAINT chk_invoices_status
    CHECK (status IN ('draft','issued','paid','void'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_number ON invoices (invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_bank ON invoices (bank_id, period_start DESC);
DROP TRIGGER IF EXISTS trg_invoices_upd ON invoices;
CREATE TRIGGER trg_invoices_upd BEFORE UPDATE ON invoices
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS invoice_line_items (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id   UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    head         VARCHAR(80) NOT NULL,              -- e.g. 'Voice minutes', 'WhatsApp'
    quantity     NUMERIC(12,2) NOT NULL DEFAULT 0,  -- minutes / units
    unit_rate    NUMERIC(10,2) NOT NULL DEFAULT 0,
    amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_line_items (invoice_id);

-- usage_records.invoice_id -> invoices FK (declared after invoices exists)
ALTER TABLE usage_records DROP CONSTRAINT IF EXISTS fk_usage_invoice;
ALTER TABLE usage_records ADD CONSTRAINT fk_usage_invoice
    FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;
