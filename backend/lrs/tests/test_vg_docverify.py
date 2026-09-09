"""Contract tests for the VG Docverify real adapters (no network I/O).

These verify the adapters honour the Provider contract and degrade gracefully
(return {} instead of raising) when there's nothing to fetch — so a misconfigured
or data-less applicant never breaks scoring.
"""
import datetime as _dt
import pytest

from lrs.providers import get_providers
from lrs.providers.base import FetchContext, Provider
from lrs.providers.vg_docverify import (
    ExperianBureauProvider, ITRIncomeProvider, PanKycProvider,
    _age_from_dob, _fmt_date, _split_name, get_vg_providers,
)


def _ctx(**kw):
    base = dict(pan=None, aadhaar=None, phone=None, app={})
    base.update(kw)
    return FetchContext(**base)


def test_bundle_shape_and_pillars():
    provs = get_vg_providers()
    assert [p.pillar for p in provs] == [
        "credit_bureau", "income", "bank_statement", "personal_profile",
    ]
    assert all(isinstance(p, Provider) for p in provs)


def test_get_providers_selects_vg_when_configured(monkeypatch):
    monkeypatch.delenv("VG_MOCK_MODE", raising=False)
    monkeypatch.setenv("VG_DOCVERIFY_BASE_URL", "http://10.200.10.43/VGDocverify")
    names = [type(p).__name__ for p in get_providers()]
    assert "ExperianBureauProvider" in names


def test_get_providers_defaults_to_mock(monkeypatch):
    monkeypatch.delenv("VG_MOCK_MODE", raising=False)
    monkeypatch.delenv("VG_DOCVERIFY_BASE_URL", raising=False)
    monkeypatch.delenv("LRS_PERFIOS_API_KEY", raising=False)
    monkeypatch.delenv("LRS_KARZA_API_KEY", raising=False)
    names = [type(p).__name__ for p in get_providers()]
    assert names == [
        "MockBureauProvider", "MockIncomeProvider",
        "MockBankStmtProvider", "MockKycProvider",
    ]


@pytest.mark.asyncio
async def test_experian_returns_empty_without_identifiers():
    assert await ExperianBureauProvider().fetch(_ctx()) == {}


@pytest.mark.asyncio
async def test_itr_returns_empty_without_credentials(monkeypatch):
    monkeypatch.delenv("VG_DOCVERIFY_ITR_USERNAME", raising=False)
    monkeypatch.delenv("VG_DOCVERIFY_ITR_PASSWORD", raising=False)
    assert await ITRIncomeProvider().fetch(_ctx(pan="ABCDE1234F")) == {}


@pytest.mark.asyncio
async def test_pan_kyc_returns_empty_without_pan():
    assert await PanKycProvider().fetch(_ctx()) == {}


def test_name_split():
    assert _split_name("Rahul Kumar Sharma") == ("Rahul", "Kumar Sharma")
    assert _split_name("Rahul") == ("Rahul", "")
    assert _split_name(None) == ("", "")


def test_age_from_dob():
    assert _age_from_dob("1990-01-01") >= 30
    assert _age_from_dob(None) is None


def test_fmt_date_emits_iso_not_ambiguous_day_first():
    """VG's .NET gateway parses dates MONTH-first.

    Sending dd/mm/yyyy made it reject any DOB with day > 12 ("String was not
    recognized as a valid DateTime", statusCode 999) and — worse — silently
    read day <= 12 as the wrong date, so the bureau was queried for a DOB the
    applicant does not have. ISO 8601 is unambiguous in either culture.
    """
    assert _fmt_date(_dt.date(2003, 5, 22)) == "2003-05-22"


def test_fmt_date_does_not_swap_day_and_month():
    """The silent half of the bug: 6 May must never serialise as 5 June."""
    assert _fmt_date(_dt.date(2003, 5, 6)) == "2003-05-06"


def test_fmt_date_accepts_datetime_and_drops_time():
    assert _fmt_date(_dt.datetime(1990, 12, 31, 14, 30)) == "1990-12-31"


def test_fmt_date_passes_through_strings_and_blanks():
    """Unchanged behaviour: a value already stringified is sent as-is, and a
    missing DOB becomes an empty string rather than 'None'."""
    assert _fmt_date("2003-05-22") == "2003-05-22"
    assert _fmt_date(None) == ""
    assert _fmt_date("") == ""
