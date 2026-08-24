"""Regression tests for uploaded-file naming.

Both document-upload endpoints (`/api/upload-document` and
`/api/upload-document-session`) build the on-disk filename from two values the
customer's browser controls: the `document_type` form field and the uploaded
file's own name. Neither was filtered.

  * `document_type="../../../../etc/cron.d/x"` walked straight out of
    UPLOAD_DIR. The process runs as root, so that is an arbitrary root-owned
    file write.
  * The extension was taken verbatim from the filename while the type check
    looked only at the client-supplied `Content-Type` header. `payload.html`
    declared as `image/png` was stored as `.html` and served back from the
    public `/uploads` mount as HTML — stored XSS on our own origin.

`safe_upload_filename` is the single choke point for both.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

# main.py needs a JWT secret at import time in some configurations; keep the
# import side-effect-free for tests.
os.environ.setdefault("JWT_SECRET", "test-only-secret-not-used-for-signing")

from main import UPLOAD_DIR, safe_upload_filename  # noqa: E402


def _resolve(document_type: str, filename: str | None, loan_id: str = "LN-1") -> Path:
    """Mirror what the endpoints do with the returned name."""
    return (UPLOAD_DIR / loan_id / safe_upload_filename(document_type, filename)).resolve()


def _is_contained(p: Path, loan_id: str = "LN-1") -> bool:
    root = (UPLOAD_DIR / loan_id).resolve()
    return root == p.parent


# ── traversal ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("document_type", [
    "../../../../etc/cron.d/pwn",
    r"..\..\..\..\windows\system32\pwn",
    "../aadhaar_front",
    "..%2f..%2fpwn",
    "/etc/passwd",
    "sub/dir/aadhaar_front",
    "....//....//pwn",
    r"\x00aadhaar_front",
])
def test_document_type_cannot_escape_the_loan_directory(document_type):
    assert _is_contained(_resolve(document_type, "x.pdf")), (
        f"{document_type!r} escaped UPLOAD_DIR"
    )


@pytest.mark.parametrize("filename", [
    "../../../../etc/cron.d/pwn.pdf",
    "a/../../b.png",
    r"..\..\x.jpg",
])
def test_uploaded_filename_cannot_influence_the_path(filename):
    assert _is_contained(_resolve("aadhaar_front", filename))


def test_no_path_separator_survives_in_the_name():
    name = safe_upload_filename("../../x", "y.pdf")
    assert "/" not in name and "\\" not in name and ".." not in name


# ── served content type ─────────────────────────────────────────────────────

@pytest.mark.parametrize("filename", [
    "payload.html", "payload.svg", "payload.htm", "shell.php", "x.js",
    "a.jsp", "b.phtml", "c.xhtml", "d.exe", "e.sh",
])
def test_dangerous_extensions_are_neutralised(filename):
    """Anything outside the accepted image/pdf set must land as .bin so the
    public /uploads mount cannot serve it as active content."""
    assert safe_upload_filename("aadhaar_front", filename).endswith(".bin"), filename


@pytest.mark.parametrize("filename,expected", [
    ("scan.pdf", ".pdf"), ("scan.PDF", ".pdf"),
    ("photo.jpg", ".jpg"), ("photo.JPEG", ".jpeg"), ("photo.png", ".png"),
])
def test_legitimate_extensions_are_preserved(filename, expected):
    assert safe_upload_filename("pan_card", filename).endswith(expected)


def test_missing_or_extensionless_filename_is_handled():
    assert safe_upload_filename("pan_card", None).endswith(".bin")
    assert safe_upload_filename("pan_card", "").endswith(".bin")
    assert safe_upload_filename("pan_card", "noextension").endswith(".bin")


# ── the labels the product actually sends must survive unchanged ─────────────

@pytest.mark.parametrize("document_type", [
    "aadhaar_front", "aadhaar_back", "pan_card", "photo", "income_proof",
    "bank_statement", "salary_slips", "itr_form16", "bank_statements",
    "proof_of_identification", "proof_of_residence", "quotation",
])
def test_every_real_document_type_is_untouched(document_type):
    """The frontend derives these from the DB column names; sanitising must be
    a no-op for them or the loan_applications URL column stops being updated."""
    assert safe_upload_filename(document_type, "scan.pdf").startswith(document_type + "_")


def test_empty_document_type_still_produces_a_usable_name():
    n = safe_upload_filename("", "scan.pdf")
    assert n.startswith("document_") and n.endswith(".pdf")


def test_absurdly_long_label_is_bounded():
    n = safe_upload_filename("a" * 5000, "scan.pdf")
    assert len(n) < 100
