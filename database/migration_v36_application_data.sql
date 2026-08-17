-- ============================================================================
--  migration_v36_application_data.sql   (task #7 — application data layer)
--
--  Normalizes per-application data that today is either sprawled across fixed
--  columns or overwritten in place:
--
--    1. application_documents — one row per uploaded file. Replaces the fixed
--       7 *_url columns on loan_applications (which can't hold custom doc types,
--       repeat uploads, or per-doc who/when/verification). Backfilled from the
--       existing *_url columns so it reflects real current documents, not an
--       empty shell. The upload endpoints keep writing the *_url columns for
--       now; wiring them to also insert here is a follow-up code change.
--    2. application_notes — append-only note history. Today officer_notes /
--       supervisor_notes / review_notes are single TEXT columns that overwrite;
--       this keeps the thread. Seeded from those columns.
--    3. export_jobs — async export tracking (all-calls / daily-report / etc.)
--       so exports can move off synchronous request handling.
--
--  Additive + idempotent (backfills guarded by NOT EXISTS so re-running the
--  file — as the deploy pipeline does — never duplicates rows).
-- ============================================================================

-- ── 1. application_documents ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS application_documents (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id      uuid NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,
    bank_id             uuid REFERENCES banks(id) ON DELETE SET NULL,
    document_type       text NOT NULL,          -- aadhaar_front, pan_card, ... or a custom type
    file_url            text NOT NULL,
    original_filename   text,
    content_type        text,
    size_bytes          bigint,
    sha256              text,                    -- integrity / dedup
    uploaded_by_type    text NOT NULL DEFAULT 'applicant'
                             CHECK (uploaded_by_type IN ('applicant','bank_user','admin','system')),
    uploaded_by_id      uuid,
    uploaded_at         timestamptz NOT NULL DEFAULT now(),
    verification_status text NOT NULL DEFAULT 'pending'
                             CHECK (verification_status IN ('pending','verified','rejected')),
    verified_by         uuid,
    verified_at         timestamptz,
    rejection_reason    text
);
CREATE INDEX IF NOT EXISTS idx_appdocs_application ON application_documents (application_id);
CREATE INDEX IF NOT EXISTS idx_appdocs_bank        ON application_documents (bank_id);
CREATE INDEX IF NOT EXISTS idx_appdocs_type        ON application_documents (application_id, document_type);

-- backfill from the fixed *_url columns (only the 7 that actually exist)
INSERT INTO application_documents
    (application_id, bank_id, document_type, file_url, uploaded_by_type, uploaded_at, verification_status)
SELECT la.id, la.bank_id, d.dtype, d.url, 'applicant',
       COALESCE(la.documents_submitted_at, la.created_at, now()), 'pending'
FROM loan_applications la
CROSS JOIN LATERAL (VALUES
    ('aadhaar_front',  la.aadhaar_front_url),
    ('aadhaar_back',   la.aadhaar_back_url),
    ('pan_card',       la.pan_card_url),
    ('photo',          la.photo_url),
    ('income_proof',   la.income_proof_url),
    ('bank_statement', la.bank_statement_url),
    ('quotation',      la.quotation_url)
) AS d(dtype, url)
WHERE d.url IS NOT NULL AND d.url <> ''
  AND NOT EXISTS (
      SELECT 1 FROM application_documents ad
      WHERE ad.application_id = la.id AND ad.document_type = d.dtype AND ad.file_url = d.url
  );

-- ── 2. application_notes ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS application_notes (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id uuid NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,
    bank_id        uuid REFERENCES banks(id) ON DELETE SET NULL,
    author_type    text NOT NULL DEFAULT 'bank_user'
                        CHECK (author_type IN ('bank_user','admin','system')),
    author_id      uuid,
    author_name    text,
    note           text NOT NULL,
    note_kind      text NOT NULL DEFAULT 'general'
                        CHECK (note_kind IN ('general','officer','supervisor','review','system')),
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_appnotes_application ON application_notes (application_id, created_at DESC);

-- seed from the single-column notes so the history isn't lost
INSERT INTO application_notes (application_id, bank_id, author_type, note, note_kind, created_at)
SELECT la.id, la.bank_id, 'system', n.note, n.kind, COALESCE(la.updated_at, la.created_at, now())
FROM loan_applications la
CROSS JOIN LATERAL (VALUES
    (la.officer_notes,    'officer'),
    (la.supervisor_notes, 'supervisor'),
    (la.review_notes,     'review')
) AS n(note, kind)
WHERE n.note IS NOT NULL AND btrim(n.note) <> ''
  AND NOT EXISTS (
      SELECT 1 FROM application_notes an
      WHERE an.application_id = la.id AND an.note_kind = n.kind AND an.note = n.note
  );

-- ── 3. export_jobs ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS export_jobs (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id           uuid REFERENCES banks(id) ON DELETE CASCADE,
    requested_by_type text NOT NULL DEFAULT 'bank_user'
                           CHECK (requested_by_type IN ('bank_user','admin','system')),
    requested_by_id   uuid,
    export_type       text NOT NULL,            -- all_calls, daily_report, applications, ...
    params            jsonb NOT NULL DEFAULT '{}'::jsonb,
    status            text NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued','running','completed','failed')),
    file_url          text,
    row_count         int,
    error             text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    started_at        timestamptz,
    completed_at      timestamptz
);
CREATE INDEX IF NOT EXISTS idx_export_jobs_bank    ON export_jobs (bank_id, status);
CREATE INDEX IF NOT EXISTS idx_export_jobs_created ON export_jobs (created_at DESC);
