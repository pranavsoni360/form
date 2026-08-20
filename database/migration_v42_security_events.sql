-- migration_v42_security_events.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Security-events layer for the tiered audit design.
--
-- A derived anomaly/alert store fed by detectors that sit on top of the
-- append-only evidence stores (login_audit, activity_log, officer_action_log …).
-- Tier-scoped by bank_id / branch_id:
--   bank_id IS NULL  -> platform-level event (super admin only)
--   bank_id set, branch_id NULL -> bank-wide event (bank admin + super admin)
--   branch_id set    -> branch event (branch + bank admin + super admin)
--
-- Carries the same who/where envelope as the other stores (ip, machine_ip,
-- machine_name, geo). DELETE is blocked and core columns are immutable; only the
-- acknowledgement columns may change (so alerts can be triaged without letting
-- anyone rewrite the evidence).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS security_events (
    id              BIGSERIAL PRIMARY KEY,
    event_type      VARCHAR(48)  NOT NULL,
    severity        VARCHAR(12)  NOT NULL DEFAULT 'medium',
    actor_type      VARCHAR(24),
    actor_id        UUID,
    actor_username  VARCHAR(255),
    actor_role      VARCHAR(48),
    bank_id         UUID,
    branch_id       UUID,
    title           VARCHAR(255) NOT NULL,
    description     TEXT,
    entity_type     VARCHAR(48),
    entity_id       UUID,
    ip_address      INET,
    machine_ip      INET,
    machine_name    VARCHAR(255),
    user_agent      TEXT,
    location        JSONB,
    session_id      VARCHAR(255),
    request_id      VARCHAR(255),
    metadata        JSONB,
    acknowledged    BOOLEAN NOT NULL DEFAULT false,
    acknowledged_by UUID,
    acknowledged_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_secev_severity CHECK (severity IN ('info','low','medium','high','critical'))
);

CREATE INDEX IF NOT EXISTS idx_secev_created ON security_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_secev_bank    ON security_events (bank_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_secev_branch  ON security_events (branch_id, created_at DESC) WHERE branch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_secev_type    ON security_events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_secev_sev     ON security_events (severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_secev_unack   ON security_events (acknowledged, created_at DESC) WHERE acknowledged = false;

-- Tamper-evidence: block DELETE; allow UPDATE only of the acknowledgement columns.
CREATE OR REPLACE FUNCTION fn_secev_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'security_events is append-only (DELETE blocked)';
    END IF;
    IF ROW(NEW.event_type, NEW.severity, NEW.actor_id, NEW.bank_id, NEW.branch_id,
           NEW.title, NEW.ip_address, NEW.machine_ip, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.event_type, OLD.severity, OLD.actor_id, OLD.bank_id, OLD.branch_id,
           OLD.title, OLD.ip_address, OLD.machine_ip, OLD.created_at) THEN
        RAISE EXCEPTION 'security_events core columns are immutable (only acknowledgement may change)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_secev_guard ON security_events;
CREATE TRIGGER trg_secev_guard BEFORE UPDATE OR DELETE ON security_events
    FOR EACH ROW EXECUTE FUNCTION fn_secev_guard();

-- Grant the runtime (scoped) role DML access — new tables are not auto-granted.
-- Works for whichever app role exists in this environment (QA / prod).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'los_app_qa') THEN
        GRANT SELECT, INSERT, UPDATE ON security_events TO los_app_qa;
        GRANT USAGE, SELECT ON SEQUENCE security_events_id_seq TO los_app_qa;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'los_app') THEN
        GRANT SELECT, INSERT, UPDATE ON security_events TO los_app;
        GRANT USAGE, SELECT ON SEQUENCE security_events_id_seq TO los_app;
    END IF;
END $$;
