-- ============================================================================
--  migration_v35_notifications.sql   (task #7 — notifications layer)
--
--  Complements the existing whatsapp_messages delivery LOG. It does NOT
--  replace it. Adds the three things the log alone can't give us:
--
--    1. notification_templates — bank-editable, versioned, per-channel message
--       templates. Matches the dashboard's template-management intent and gives
--       a home to the provider template names (e.g. AiSensy) that today are
--       hard-coded, which is the root of the known form_link 400 mismatch.
--    2. notification_optouts — a consent-withdrawal registry (DPDP). When a
--       recipient opts out (STOP keyword, request, bounce, compliance hold) we
--       record it so the sender can suppress future messages. This is a
--       compliance requirement, not a nice-to-have.
--    3. whatsapp_messages tenant-scoping — the log had no bank_id, so sends
--       could not be attributed/billed per bank. Add bank_id + template_id
--       (nullable, additive) and backfill bank_id from the linked application.
--
--  All additive + idempotent. No existing column/table is dropped or altered
--  destructively. PG16 features used: NULLS NOT DISTINCT partial unique index
--  (so a single platform-default row — bank_id NULL — is enforced as unique).
-- ============================================================================

-- ── 1. Template registry ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_templates (
    id                     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id                uuid REFERENCES banks(id) ON DELETE CASCADE,   -- NULL = platform default
    channel                text NOT NULL CHECK (channel IN ('whatsapp','sms','email','voice')),
    key                    text NOT NULL,          -- logical name: 'form_link','approval','reminder',...
    language               text NOT NULL DEFAULT 'en',
    body                   text NOT NULL,
    provider_template_name text,                   -- provider-side template id (e.g. AiSensy)
    version                int  NOT NULL DEFAULT 1,
    status                 text NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active','draft','archived')),
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

-- exactly one ACTIVE template per (bank, channel, key, language).
-- NULLS NOT DISTINCT so the platform-default row (bank_id NULL) is also unique.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_notif_template
    ON notification_templates (bank_id, channel, key, language)
    NULLS NOT DISTINCT
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_notif_template_bank ON notification_templates (bank_id);

DROP TRIGGER IF EXISTS trg_notif_template_upd ON notification_templates;
CREATE TRIGGER trg_notif_template_upd BEFORE UPDATE ON notification_templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── 2. Opt-out / consent-withdrawal registry (DPDP) ─────────────────────────
CREATE TABLE IF NOT EXISTS notification_optouts (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id      uuid REFERENCES banks(id) ON DELETE CASCADE,   -- NULL = global opt-out (all banks)
    phone        varchar(15) NOT NULL,
    channel      text NOT NULL CHECK (channel IN ('whatsapp','sms','email','voice','all')),
    opted_out_at timestamptz NOT NULL DEFAULT now(),
    source       text NOT NULL DEFAULT 'user_request'
                      CHECK (source IN ('user_request','stop_keyword','bounce','admin','compliance')),
    note         text
);

-- one standing opt-out per (bank, phone, channel); NULL bank = global, enforced unique.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_notif_optout
    ON notification_optouts (bank_id, phone, channel)
    NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_notif_optout_phone ON notification_optouts (phone);

-- ── 3. Tenant-scope the existing delivery log ───────────────────────────────
ALTER TABLE whatsapp_messages
    ADD COLUMN IF NOT EXISTS bank_id     uuid REFERENCES banks(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS template_id uuid REFERENCES notification_templates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_bank ON whatsapp_messages (bank_id);

-- best-effort backfill: attribute historic messages to the application's bank
UPDATE whatsapp_messages w
   SET bank_id = la.bank_id
  FROM loan_applications la
 WHERE w.application_id = la.id
   AND w.bank_id IS NULL
   AND la.bank_id IS NOT NULL;
