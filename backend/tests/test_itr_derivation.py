"""ITR income derivation, and the rules around the credential that fetches it.

VG's ITR_Advance returns a complete tax extract — balance sheet, P&L, presumptive
income sections, cash balances. The scorecard needs one number: monthly income.
These tests pin how that number is chosen, because the extract offers several
plausible candidates that mean very different things:

  presInc (44ADA/44AD)   presumptive income — what the filer is DEEMED to earn
  plSumm.inc.totalIncome revenue/receipts
  totalProfitBeforeTax   profit
  compToEmplys.salWages  what the filer PAID staff — NOT income, easy to misread

Fixtures use the vendor's ACTUAL response nesting — confirmed against a live
UAT call — with synthetic amounts. The structure is what matters for derivation
and is reproduced faithfully; no real taxpayer's figures are stored here.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from lrs.itr_routes import ItrGenerateRequest, derive_itr_income  # noqa: E402

# Vendor's real nesting, synthetic amounts.
SELF_EMPLOYED_44ADA = {"itrData": {"assmtYr": [{"financialYear": "2025-26", "finInfo": {
    "plDtld": {"plAcct": {
        "presumpInc44AD": {"slNo": [{"grsTrnovrGrsRecpts": {"othMode": 720000, "ttl": 720000},
                                     "presInc": {"8PrcntOfGrsTrnOthMode": 288000, "ttl": 288000}}]},
        "presumpInc44ADA": {"slNo": [{"grsRecpts": 240000, "presInc": 204000}]},
        "grsPrftTrfdFrmTrdgAcct": 450000, "pat": 450000}},
    "plSumm": {"inc": {"revenueFromOperations": 240000, "totalIncome": 240000},
               "totalProfitBeforeTax": 450000}}}]}}


def test_prefers_44ADA_presumptive_income():
    """44ADA presumptive income is the truest figure for a self-employed filer.

    The same return also carries totalIncome 240000 and profitBeforeTax 450000.
    Picking either would misstate earning capacity — receipts are not income, and
    profit before tax on a presumptive return is not what the filer declared.
    """
    out = derive_itr_income(SELF_EMPLOYED_44ADA)
    assert out["itr_income_basis"] == "presumptive_44ADA"
    assert out["annual_income"] == 204000.0
    assert out["net_monthly_income"] == 17000.0
    assert out["itr_financial_year"] == "2025-26"


def test_44AD_used_when_44ADA_absent():
    data = {"itrData": {"assmtYr": [{"financialYear": "2025-26", "finInfo": {
        "plDtld": {"plAcct": {"presumpInc44AD": {"slNo": [{"presInc": {"ttl": 288000}}]}}}}}]}}
    out = derive_itr_income(data)
    assert out["itr_income_basis"] == "presumptive_44AD"
    assert out["annual_income"] == 288000.0


def test_salaried_style_return_uses_total_income():
    """This is a salaried-only product; such a return has no presumptive section."""
    data = {"itrData": {"assmtYr": [{"financialYear": "2025-26",
            "finInfo": {"plSumm": {"inc": {"totalIncome": 840000}}}}]}}
    out = derive_itr_income(data)
    assert out["itr_income_basis"] == "total_income"
    assert out["net_monthly_income"] == 70000.0


def test_newest_financial_year_wins():
    """Earning capacity is current, so an older filing must not override a newer."""
    data = {"itrData": {"assmtYr": [
        {"financialYear": "2023-24", "finInfo": {"plSumm": {"totalProfitBeforeTax": 100000}}},
        {"financialYear": "2025-26", "finInfo": {"plSumm": {"totalProfitBeforeTax": 300000}}},
        {"financialYear": "2024-25", "finInfo": {"plSumm": {"totalProfitBeforeTax": 200000}}}]}}
    out = derive_itr_income(data)
    assert out["itr_financial_year"] == "2025-26"
    assert out["annual_income"] == 300000.0
    assert out["itr_years"] == ["2025-26", "2024-25", "2023-24"]


def test_salaries_paid_to_staff_are_never_read_as_income():
    """compToEmplys.salWages is money the filer PAID OUT.

    Reading it as income would invent earnings for someone who employs people —
    the most dangerous available misreading, because the field name looks right.
    """
    data = {"itrData": {"assmtYr": [{"financialYear": "2025-26", "finInfo": {
        "plDtld": {"plAcct": {"otherExpns": {"compToEmplys": {"salWages": 2400000}}}}}}]}}
    out = derive_itr_income(data)
    assert "annual_income" not in out, "staff salaries must never become income"


@pytest.mark.parametrize("bad", [
    {},
    {"itrData": {}},
    {"itrData": {"assmtYr": []}},
    {"itrData": {"assmtYr": "not-a-list"}},
    {"itrData": {"assmtYr": [{"financialYear": "2025-26", "finInfo": "not-a-dict"}]}},
    {"itrData": {"assmtYr": [{"financialYear": "2025-26",
                              "finInfo": {"plSumm": {"totalProfitBeforeTax": 0}}}]}},
])
def test_unusable_responses_yield_no_income_and_never_raise(bad):
    """No filed return is a normal outcome; a zero figure is not income."""
    out = derive_itr_income(bad)
    assert "annual_income" not in out


def test_negative_or_junk_amounts_are_not_accepted():
    for amount in (-50000, "abc", None, [], {}):
        data = {"itrData": {"assmtYr": [{"financialYear": "2025-26",
                "finInfo": {"plSumm": {"totalProfitBeforeTax": amount}}}]}}
        out = derive_itr_income(data)
        assert out.get("annual_income") is None or out["annual_income"] > 0


# ── the credential ──────────────────────────────────────────────────────────

def test_password_is_not_exposed_by_repr_or_str():
    """A traceback or a stray log call must not print a tax password.

    The request model is the one object holding it, so its repr is the most
    likely accidental leak path.
    """
    req = ItrGenerateRequest(session_token="t", username="ABCDE1234F",
                             password="sup3r-s3cret", number_of_years="3")
    for rendered in (repr(req), str(req), f"{req}"):
        assert "sup3r-s3cret" not in rendered
        assert "redacted" in rendered.lower()


def test_number_of_years_rejects_anything_but_one_digit():
    """Guards against an injected value reaching the vendor payload."""
    for bad in ("0", "12", "", "3; DROP", "abc", "-1"):
        with pytest.raises(Exception):
            ItrGenerateRequest(session_token="t", username="u", password="p",
                               number_of_years=bad)


def test_unexpected_fields_are_refused():
    """extra='forbid' — a client cannot smuggle another field into the payload."""
    with pytest.raises(Exception):
        ItrGenerateRequest(session_token="t", username="u", password="p",
                           number_of_years="3", store_password=True)


# ── host / credential pairing ───────────────────────────────────────────────

def test_itr_uses_the_same_host_as_its_credentials():
    """The ITR endpoint must be built from the host the credentials belong to.

    This module originally declared its own
    `os.getenv("VG_DOCVERIFY_BASE_URL", "https://vpays.in/VGDocverify")`, while
    vg_docverify.py defaulted to the UAT host. With the variable unset — which is
    how every environment currently runs — the two disagreed. Credentials are
    chosen FROM the host by `_creds_for`, and itr_routes imports those
    credentials, so it sent UAT user 33 to the production host. VG answered with
    no result and the customer saw "No income-tax return was found for those
    credentials" no matter what they typed.

    A second os.getenv for the same variable is the bug. Assert the single
    source of truth instead.
    """
    from lrs import itr_routes
    from lrs.providers import vg_docverify

    assert itr_routes._VGK_BASE.startswith(vg_docverify._BASE_URL), (
        "ITR endpoint host must match the host the credentials were resolved for"
    )


def test_credentials_match_the_resolved_host():
    """Whichever host is configured, the credential set must belong to it."""
    from lrs.providers import vg_docverify as vg

    expected = vg._creds_for(vg._BASE_URL)
    # Env overrides win by design; only compare when they are not set.
    import os
    if not os.getenv("VG_DOCVERIFY_USER_ID"):
        assert vg._USER_ID == expected["user_id"]
    if not os.getenv("VG_DOCVERIFY_BANK_SHORT_CODE"):
        assert vg._BANK_SHORT_CODE == expected["bank_short_code"]


# ── empty-result diagnosis ──────────────────────────────────────────────────

def test_status_102_blames_the_login_not_a_missing_return():
    """102 is what VG returns when the portal login fails.

    Confirmed by probe: an otherwise-valid request with EMPTY username/password
    returns statusCode 102 and an empty result. The old fixed message said "no
    income-tax return was found", which sent the customer looking for a return
    that exists, when the real problem was the credentials.
    """
    from lrs.itr_routes import _explain_empty_result
    msg = _explain_empty_result("102", "")
    assert "user ID and password" in msg
    assert "upload the PDF" in msg


def test_unknown_status_does_not_blame_the_customer():
    """Where we do not know the cause, we must not assert one.

    Saying "check your credentials" for what may be a vendor outage sends the
    customer round a loop they cannot win.
    """
    from lrs.itr_routes import _explain_empty_result
    msg = _explain_empty_result("999", "")
    assert "could not be fetched" in msg or "could be fetched" in msg
    assert "upload the PDF" in msg


def test_vendor_message_wins_over_our_guess():
    """If VG says something specific, that beats anything we could infer."""
    from lrs.itr_routes import _explain_empty_result
    msg = _explain_empty_result("999", "PAN not registered on the portal")
    assert msg.startswith("PAN not registered on the portal")
    assert "upload the PDF" in msg


def test_every_explanation_offers_the_upload_fallback():
    """Generate is optional by design; a failure must always name the way out."""
    from lrs.itr_routes import _explain_empty_result
    for status in ("101", "102", "103", "999", None):
        assert "upload the PDF" in _explain_empty_result(status, "").lower() \
            or "upload the pdf" in _explain_empty_result(status, "").lower()
