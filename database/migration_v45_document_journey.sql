-- ============================================================================
-- v45 — record HOW each document was obtained, not just that it exists
--
-- application_documents recorded who uploaded (applicant / officer) and what
-- the file was, but not the journey that produced it. Those are different
-- questions with very different trust implications:
--
--   an Aadhaar PDF fetched from DigiLocker is issuer-signed
--   an Aadhaar PDF the applicant picked from their phone is whatever they picked
--
-- Both landed as uploaded_by_type='applicant' with no way to tell them apart,
-- so a self-supplied ID was indistinguishable from a verified one at review
-- time. `journey` records which path the document actually took, mirroring
-- `_DOC_JOURNEYS` in backend/main.py and `journey` in
-- frontend/lib/utils/loanDocuments.ts.
--
--   fetch   retrieved from an authorised source (DigiLocker)
--   vendor  collected and parsed by a third party (Digitap statement analysis)
--   parse   applicant supplied it AND we extract data from it
--   upload  stored for a human to read; no extraction
--
-- Nullable with no default: rows written before this migration genuinely do not
-- know their journey, and guessing 'upload' for them would assert something
-- untrue about historical Aadhaar documents that may well have been fetched.
-- NULL reads honestly as "not recorded".
--
-- Numbered v45 because two files already share v42. The runner tracks by
-- filename and breaks ties alphabetically, so that pair is harmless, but the
-- sequence should not collide again.
-- ============================================================================

ALTER TABLE application_documents
    ADD COLUMN IF NOT EXISTS journey text;

-- Constrain to the four known journeys. NULL stays allowed for historical rows.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'application_documents_journey_check'
    ) THEN
        ALTER TABLE application_documents
            ADD CONSTRAINT application_documents_journey_check
            CHECK (journey IS NULL OR journey IN ('fetch', 'vendor', 'parse', 'upload'));
    END IF;
END $$;

-- Officer review reads "show me everything for this application", and the
-- journey is part of that answer, so it rides the existing access path.
CREATE INDEX IF NOT EXISTS idx_application_documents_app_journey
    ON application_documents (application_id, journey);
