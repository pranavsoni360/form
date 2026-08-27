"""ITR income derivation, and the rules around the credential that fetches it.

VG's ITR_Advance returns a complete tax extract — balance sheet, P&L, presumptive
income sections, cash balances. The scorecard needs one number: monthly income.
These tests pin how that number is chosen, because the extract offers several
plausible candidates that mean very different things:

  presInc (44ADA/44AD)   presumptive income — what the filer is DEEMED to earn
  plSumm.inc.totalIncome revenue/receipts
  totalProfitBeforeTax   profit
  compToEmplys.salWages  what the filer PAID staff — NOT income, easy to misread

Fixtures come from a real UAT capture (2026-08-27, user 33), so the nesting is
the vendor's actual shape rather than one inferred from a doc.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from lrs.itr_routes import ItrGenerateRequest, derive_itr_income  # noqa: E402

# Trimmed from the real capture, exact nesting and values preserved.
REAL_SELF_EMPLOYED = {"itrData": {"assmtYr": [{"financialYear": "2025-26", "finInfo": {
    "plDtld": {"plAcct": {
        "presumpInc44AD": {"slNo": [{"grsTrnovrGrsRecpts": {"othMode": 598300, "ttl": 598300},
                                     "presInc": {"8PrcntOfGrsTrnOthMode": 236608, "ttl": 236608}}]},
        "presumpInc44ADA": {"slNo": [{"grsRecpts": 185700, "presInc": 157940}]},
        "grsPrftTrfdFrmTrdgAcct": 394548, "pat": 394548}},
    "plSumm": {"inc": {"revenueFromOperations": 185700, "totalIncome": 185700},
               "totalProfitBeforeTax": 394548}}}]}}


def test_real_capture_prefers_44ADA_presumptive_income():
    """44ADA presumptive income is the truest figure for a self-employed filer.

    The same return also carries totalIncome 185700 and profitBeforeTax 394548.
    Picking either would misstate earning capacity — receipts are not income, and
    profit before tax on a presumptive return is not what the filer declared.
    """
    out = derive_itr_income(REAL_SELF_EMPLOYED)
    assert out["itr_income_basis"] == "presumptive_44ADA"
    assert out["annual_income"] == 157940.0
    assert out["net_monthly_income"] == 13161.67
    assert out["itr_financial_year"] == "2025-26"


def test_44AD_used_when_44ADA_absent():
    data = {"itrData": {"assmtYr": [{"financialYear": "2025-26", "finInfo": {
        "plDtld": {"plAcct": {"presumpInc44AD": {"slNo": [{"presInc": {"ttl": 236608}}]}}}}}]}}
    out = derive_itr_income(data)
    assert out["itr_income_basis"] == "presumptive_44AD"
    assert out["annual_income"] == 236608.0


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
