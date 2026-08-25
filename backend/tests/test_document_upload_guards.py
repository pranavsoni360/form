"""Document uploads must be validated by content, and must never lie about success.

Three defects this file pins down, all found auditing the customer loan form:

1. **Uploads were validated on the browser-declared Content-Type alone.** That
   header is attacker-controlled, so a renamed executable sent as
   `application/pdf` was written under /uploads/ and served back. The same check
   also REJECTED valid files, because some Android pickers send
   `application/octet-stream` for a real PDF.

2. **The server had no per-document rule.** The browser insisted a bank
   statement be a PDF — Digitap's parser template-matches the issuing bank's
   layout, so a photo of a statement yields nothing — but any request that
   skipped the UI could attach a JPG, and it would reach scoring unreadable.

3. **A failed column write reported success.** The `UPDATE loan_applications SET
   <col>` was wrapped in try/except that logged a warning and returned
   `{"status": "uploaded"}`. The form decides "is this required document
   satisfied?" by reading the persisted row, and `_validate_documents` gates
   submission on the same columns — so a swallowed failure showed the customer a
   green tick on a document they could never submit. That is exactly how the
   missing `bank_statements_url` column turned into an unsubmittable
   application.

`_validate_documents` itself is covered here too: it is the server-side mirror
of the form's required-document gate, and before it existed the red asterisks
were decoration that a direct POST ignored entirely.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import main as main_mod  # noqa: E402

# Real leading bytes for each accepted format, plus things that must be refused.
PDF = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"
PNG = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
JPG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00"
EXE = b"MZ\x90\x00\x03\x00\x00\x00"          # Windows executable
HTML = b"<html><script>alert(1)</script>"
ZIP = b"PK\x03\x04\x14\x00\x00\x00"


# ── sniffing ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("content,expected", [
    (PDF, "pdf"), (PNG, "png"), (JPG, "jpg"),
    (EXE, None), (HTML, None), (ZIP, None), (b"", None),
])
def test_sniff_reads_the_files_own_bytes(content, expected):
    assert main_mod.sniff_upload_kind(content) is expected


# ── per-document type rules ─────────────────────────────────────────────────

@pytest.mark.parametrize("document_type,content", [
    ("bank_statements", PDF),
    ("bank_statement", PDF),
    ("itr_form16", PDF),
    ("photo", JPG),
    ("photo", PNG),
    ("aadhaar_front", PDF),
    ("aadhaar_front", JPG),
    ("quotation", PDF),
    ("salary_slips", JPG),
])
def test_accepts_what_the_document_actually_needs(document_type, content):
    assert main_mod.validate_upload_content(document_type, content)


def test_bank_statement_refuses_a_photograph():
    """Digitap template-matches the bank's PDF; a JPG cannot be parsed at all."""
    with pytest.raises(HTTPException) as e:
        main_mod.validate_upload_content("bank_statements", JPG)
    assert e.value.status_code == 400
    assert "PDF" in e.value.detail


def test_passport_photo_refuses_a_pdf():
    """Downstream consumers render a face; a PDF breaks every one of them."""
    with pytest.raises(HTTPException) as e:
        main_mod.validate_upload_content("photo", PDF)
    assert e.value.status_code == 400
    assert "JPG" in e.value.detail or "PNG" in e.value.detail


@pytest.mark.parametrize("payload,label", [(EXE, "executable"), (HTML, "html"), (ZIP, "zip")])
def test_disguised_payloads_are_refused(payload, label):
    """Content-Type is attacker-controlled; the bytes are not."""
    with pytest.raises(HTTPException) as e:
        main_mod.validate_upload_content("bank_statements", payload)
    assert e.value.status_code == 400


def test_empty_file_is_refused_with_a_useful_message():
    with pytest.raises(HTTPException) as e:
        main_mod.validate_upload_content("photo", b"")
    assert "empty" in e.value.detail.lower()


def test_unknown_document_type_falls_back_to_permissive_not_crash():
    """An unmapped type must still be a real file, but may be any of the three."""
    assert main_mod.validate_upload_content("some_new_doc", PDF)
    with pytest.raises(HTTPException):
        main_mod.validate_upload_content("some_new_doc", EXE)


def test_every_form_document_type_has_an_explicit_rule():
    """A document the form can upload must not silently inherit the default.

    Guards against adding a row to loanDocuments.ts without deciding whether a
    photograph of it is acceptable.
    """
    from_form = {
        "aadhaar_front", "photo", "bank_statements", "salary_slips",
        "itr_form16", "proof_of_identification", "proof_of_residence", "quotation",
    }
    missing = from_form - set(main_mod._DOC_KINDS)
    assert not missing, f"no explicit content rule for: {sorted(missing)}"


# ── submission gate ─────────────────────────────────────────────────────────

FULL = {
    "aadhaar_front_url": "/u/a.pdf",
    "photo_url": "/u/p.jpg",
    "bank_statements_url": "/u/b.pdf",
}


def test_complete_application_passes():
    main_mod._validate_documents(dict(FULL))


def test_empty_application_is_refused_and_names_everything_missing():
    with pytest.raises(HTTPException) as e:
        main_mod._validate_documents({})
    detail = e.value.detail
    assert e.value.status_code == 400
    for label in ("Aadhaar Document", "Passport Size Photo", "Bank Statements"):
        assert label in detail


def test_missing_bank_statement_is_named_specifically():
    """The customer must know WHICH document, not that "documents" are missing."""
    app = {k: v for k, v in FULL.items() if k != "bank_statements_url"}
    with pytest.raises(HTTPException) as e:
        main_mod._validate_documents(app)
    assert "Bank Statements" in e.value.detail
    assert "Aadhaar" not in e.value.detail


def test_legacy_singular_column_still_satisfies_the_requirement():
    """Rows created before v44 stored the statement in bank_statement_url."""
    main_mod._validate_documents({
        "aadhaar_front_url": "/u/a.pdf",
        "photo_url": "/u/p.jpg",
        "bank_statement_url": "/u/b.pdf",   # singular
    })


def test_whitespace_is_not_a_document():
    with pytest.raises(HTTPException):
        main_mod._validate_documents({**FULL, "photo_url": "   "})


def test_none_is_not_a_document():
    with pytest.raises(HTTPException):
        main_mod._validate_documents({**FULL, "photo_url": None})


def test_consumer_durable_also_requires_the_dealer_quotation():
    with pytest.raises(HTTPException) as e:
        main_mod._validate_documents({**FULL, "consumer_loan_type": "consumer_durable"})
    assert "Dealer Quotation" in e.value.detail

    main_mod._validate_documents({
        **FULL, "consumer_loan_type": "consumer_durable", "quotation_url": "/u/q.pdf",
    })


def test_personal_loan_does_not_require_a_quotation():
    main_mod._validate_documents({**FULL, "consumer_loan_type": "personal"})


# ── journeys ────────────────────────────────────────────────────────────────
#
# A document's journey is how it is OBTAINED, and it drives what the customer is
# asked to do. Before this existed the form knew one verb — "Upload" — so it
# demanded a file for Aadhaar (which DigiLocker already delivers) and for ITR
# (which is fetchable), while a bank statement that must be machine-readable got
# the same treatment as a salary slip nobody parses.

def test_every_uploadable_document_declares_a_journey():
    """A new document must not inherit a journey by accident."""
    for document_type in main_mod._DOC_KINDS:
        assert document_type in main_mod._DOC_JOURNEYS, (
            f"{document_type} has a content rule but no declared journey"
        )


def test_journeys_are_from_the_known_set():
    assert set(main_mod._DOC_JOURNEYS.values()) <= {"fetch", "vendor", "parse", "upload"}


def test_bank_statement_is_a_parse_journey():
    """It is the only document feeding the cash-flow pillar; storing is not enough."""
    assert main_mod._DOC_JOURNEYS["bank_statements"] == "parse"
    assert main_mod._DOC_JOURNEYS["bank_statement"] == "parse"


def test_digilocker_backed_documents_are_fetch_journeys():
    for document_type in ("aadhaar_front", "photo", "proof_of_identification",
                          "proof_of_residence"):
        assert main_mod._DOC_JOURNEYS[document_type] == "fetch"


def test_itr_is_not_a_credential_fetch():
    """ITR_Advance wants the applicant's income-tax portal PASSWORD.

    That credential controls their entire tax identity, and a lender collecting
    it — even in transit, even unstored — takes on liability out of all
    proportion to an optional document. If this test fails, someone wired
    ITR_Advance into the customer journey; that decision needs retaking, not a
    test update.
    """
    assert main_mod._DOC_JOURNEYS["itr_form16"] == "upload"
