-- ============================================================================
--  v42 — Bank Statement Analysis (BSA) via Digitap / VGDocverify AcAggregator
--
--  WHY THIS EXISTS
--  ---------------
--  The `banking_behaviour` scorecard pillar (weight 20) is currently fed by
--  backend/lrs/providers/mock.py::MockBankStmtProvider — i.e. it is scored on
--  FABRICATED numbers. AcAggregator is the first real source for it.
--
--  WHY A TABLE AND NOT JUST A PROVIDER
--  -----------------------------------
--  Every other LRS provider is synchronous: fetch(ctx) calls an API and returns
--  metrics. AcAggregator cannot work that way — it is a multi-step BORROWER
--  JOURNEY:
--
--      Generateurl  ->  borrower leaves the app, uploads a PDF at Digitap
--                   ->  callback fires (minutes to hours later)
--                   ->  statuscheck  ->  retrievereport
--
--  Nothing about that fits inside one scoring call, so the journey needs durable
--  state. The LRS provider then reads the last COMPLETED fetch for the
--  application instead of calling the vendor itself.
--
--  CALL BUDGET (a deliberate constraint, not an accident)
--  -----------------------------------------------------
--  Digitap has no single "give me the report" endpoint, so three calls per
--  journey is the floor: Generateurl -> statuscheck -> retrievereport. The
--  callback is what removes POLLING: it tells us when to make calls 2 and 3.
--  `next_poll_at` exists only as the fallback for a callback that never
--  arrives (see below) — it is not a polling loop.
--
--  WHY A FALLBACK IS REQUIRED
--  --------------------------
--  Confirmed by live test: when a borrower uploads a statement from the wrong
--  bank, Digitap raises error 065 inside ITS OWN UI. No callback fires, and
--  statuscheck keeps returning TxnNotFound. So a journey can fail leaving no
--  server-side signal at all. Without a time-based sweep those applications sit
--  in limbo forever.
--
--  Also confirmed: TxnNotFound does NOT mean "gone". Digitap creates no
--  transaction until the borrower actually opens the link, so a brand-new
--  request returns TxnNotFound too. It means "pending" until `expires_at`
--  passes, and only then "failed". The status enum below encodes that.
-- ============================================================================

-- ── Per-bank vendor configuration ───────────────────────────────────────────
-- Hosts, credentials and the callback URL are environment-specific: today
-- everything points at Digitap's SANDBOX (svcdemo.digitap.work, and a
-- dg-bank-data-demo S3 bucket). Production will be a different base_url and may
-- add an API key. Keeping it in a table means go-live is a config change, not a
-- deploy.
--
-- bank_id NULL = the platform-wide default row.
CREATE TABLE IF NOT EXISTS bsa_tenant_config (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id         UUID REFERENCES banks(id) ON DELETE CASCADE,

    -- e.g. http://10.200.10.43/VGDocverify/AcAggregator.asmx
    base_url        TEXT NOT NULL,
    -- Reserved: no auth was observed on ANY AcAggregator call. If production
    -- introduces a key/signature it lands here rather than in code.
    api_key         TEXT,

    -- What we send as txn_completed_cburl. This is OUR endpoint — the parameter
    -- is supplied per request, not fixed by Digitap. The sample doc pointed it at
    -- VG's own VGIL_TxnCallback.aspx, which is why it looked vendor-owned.
    callback_url    TEXT,
    -- Where Digitap returns the borrower's browser after the journey.
    return_url      TEXT,

    -- Defaults for a journey; overridable per fetch.
    default_months          SMALLINT NOT NULL DEFAULT 6,
    default_acceptance_policy VARCHAR(48) NOT NULL DEFAULT 'atLeastOneTransactionInRange',

    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_bsa_policy CHECK (default_acceptance_policy IN (
        'atLeastOneTransactionInRange',
        'atLeastOneTransactionPerMonthInRange',
        'exactStatementRange'
    ))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bsa_tenant_config_bank
    ON bsa_tenant_config (COALESCE(bank_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE is_active = TRUE;

COMMENT ON TABLE bsa_tenant_config IS
    'Per-bank AcAggregator config. bank_id NULL = platform default. Going live is a base_url change here, not a code change.';


-- ── Cached institution list ─────────────────────────────────────────────────
-- InstitutionList is a 4th endpoint but it is reference data, not per-applicant:
-- 90 rows for Statement, 40 for NetBanking, changing rarely. Caching it keeps
-- the per-application budget at three calls.
--
-- Confirmed quirks this table has to survive:
--   * `username_regex` is ABSENT from every Statement row (present on only 17 of
--     40 NetBanking rows) — hence nullable, and never used for validation.
--   * The list contains sandbox entities (ACME Bank, Setu FIP, GPay…) and banks
--     defunct since the 2019 amalgamation (Allahabad, Dena, Syndicate…).
--     `is_selectable` is how we hide those from borrowers without deleting rows
--     we might need to interpret later.
CREATE TABLE IF NOT EXISTS bsa_institutions (
    id                  BIGSERIAL PRIMARY KEY,
    -- Digitap's own integer id. Sent to Generateurl as a STRING.
    digitap_id          INTEGER NOT NULL,
    list_type           VARCHAR(16) NOT NULL,   -- Statement | NetBanking
    name                TEXT NOT NULL,
    inst_type           VARCHAR(16),            -- Bank | FIP
    form26as_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
    username_regex      TEXT,

    -- FALSE for sandbox/defunct rows. Borrower-facing pickers filter on this.
    is_selectable       BOOLEAN NOT NULL DEFAULT TRUE,
    -- Why it was hidden, so the decision is auditable rather than folklore.
    excluded_reason     VARCHAR(64),

    fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_bsa_inst_list_type CHECK (list_type IN ('Statement', 'NetBanking'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bsa_institutions
    ON bsa_institutions (digitap_id, list_type);
CREATE INDEX IF NOT EXISTS idx_bsa_institutions_selectable
    ON bsa_institutions (list_type, name) WHERE is_selectable = TRUE;

COMMENT ON COLUMN bsa_institutions.username_regex IS
    'Nullable: absent from ALL Statement rows and most NetBanking rows. Several present values have stripped backslashes (\s -> s) so they compile but are silently wrong. Never use for validation.';


-- ── One row per borrower journey ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bsa_fetches (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id      UUID NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,
    bank_id             UUID REFERENCES banks(id) ON DELETE SET NULL,

    -- accountaggregator | statementupload. Upload is the path Finix uses: the
    -- borrower already attaches a statement PDF in the application form, and
    -- co-op banks appear in the Statement list but NOT the NetBanking one.
    destination         VARCHAR(24) NOT NULL,

    -- Which bank's statement. Digitap template-matches the PDF against this, so
    -- a mismatch fails in their UI (error 065) — which is why the BORROWER picks
    -- it, not an officer guessing.
    -- NOTE: a comma-separated list is rejected (InvalidInstitution) despite the
    -- documented regex allowing it. One institution per journey; a borrower with
    -- two banks needs two rows here.
    institution_id      INTEGER,
    institution_name    TEXT,

    -- Statement window requested (upload path).
    start_month         CHAR(7),                -- YYYY-MM
    end_month           CHAR(7),

    -- ── vendor ids ──
    -- int from Generateurl, but statuscheck echoes it as a string. Stored as
    -- text to avoid a pointless cast either way.
    request_id          TEXT,
    -- Only exists AFTER the borrower engages, and only via statuscheck. A short
    -- opaque string ("da1216fe"), NOT an integer like request_id.
    txn_id              TEXT,

    -- ── borrower-facing link ──
    upload_url          TEXT,
    expires_at          TIMESTAMPTZ,            -- ~24h TTL, from `expires`

    -- ── lifecycle ──
    --   pending    link issued, borrower has not finished (statuscheck may say
    --              TxnNotFound — that is NOT failure while expires_at is future)
    --   processing callback seen / a txn exists but no report yet
    --   completed  report retrieved and stored
    --   failed     all attempts failed, or the link expired unused
    --   expired    link lapsed with no engagement at all
    status              VARCHAR(16) NOT NULL DEFAULT 'pending',
    -- Digitap's own code for the terminal attempt, e.g. ReportGenerated,
    -- AAFIDataStatusError, TxnNotFound, TxnNotCompleted, InvalidInstitution.
    -- Deliberately free text: the full enumeration is unknown, and an
    -- unrecognised code must never crash the pipeline.
    vendor_code         VARCHAR(64),
    vendor_message      TEXT,

    -- ── payloads ──
    -- The full txn_status ARRAY from statuscheck. Kept whole because one
    -- request_id can produce several attempts (a failure then a success), and
    -- reading only [0] would have picked the failure in the captured sample.
    txn_status_raw      JSONB,
    -- The type3 report. PII WARNING: contains unmasked name, email, phone, PAN,
    -- address, DOB and every transaction narration. Interacts with the retention
    -- job and the per-bank PII-redaction setting — see retention notes below.
    report_raw          JSONB,
    -- The six scorecard inputs actually derived from it. Small, non-PII, and
    -- what the LRS provider reads, so scoring never touches report_raw.
    metrics             JSONB,

    -- Raw callback body + headers, logged before being trusted. The contract is
    -- unconfirmed (no known signature), so a callback is a HINT that triggers
    -- verification, never a source of truth.
    callback_raw        JSONB,
    callback_at         TIMESTAMPTZ,

    -- Fallback sweep only, for journeys where no callback ever arrives (error
    -- 065 fires in Digitap's UI and notifies nobody). Not a polling loop.
    next_check_at       TIMESTAMPTZ,
    check_count         SMALLINT NOT NULL DEFAULT 0,

    created_by          UUID,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,

    CONSTRAINT chk_bsa_destination CHECK (destination IN ('accountaggregator', 'statementupload')),
    CONSTRAINT chk_bsa_status CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_bsa_fetches_app
    ON bsa_fetches (application_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bsa_fetches_request
    ON bsa_fetches (request_id) WHERE request_id IS NOT NULL;
-- Drives the fallback sweep: only rows that are not yet terminal.
CREATE INDEX IF NOT EXISTS idx_bsa_fetches_due
    ON bsa_fetches (next_check_at)
    WHERE status IN ('pending', 'processing');

COMMENT ON TABLE bsa_fetches IS
    'One borrower bank-statement journey. Async by nature (link -> upload -> callback -> statuscheck -> retrievereport), so the LRS provider reads the latest completed row rather than calling the vendor during scoring.';

COMMENT ON COLUMN bsa_fetches.report_raw IS
    'Full type3 report. Contains unmasked PII (name, email, phone, PAN, address, DOB) and all transaction narrations. Never log; never expose via API; subject to retention purge.';


-- ── Seed the platform default config ────────────────────────────────────────
-- LAN host by default because it is the one confirmed reachable and it keeps
-- borrower data off the public internet. Both known hosts are PLAINTEXT HTTP —
-- production must supply an HTTPS base_url before real borrower data flows.
INSERT INTO bsa_tenant_config (bank_id, base_url, callback_url, return_url)
SELECT NULL,
       'http://10.200.10.43/VGDocverify/AcAggregator.asmx',
       NULL,   -- set to https://<finix-host>/api/bsa/callback per environment
       'https://www.vgipl.com'
WHERE NOT EXISTS (SELECT 1 FROM bsa_tenant_config WHERE bank_id IS NULL);
