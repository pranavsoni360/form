"""Integration tests for the LRS orchestration service (mock providers, no DB)."""
import asyncio

from lrs import normalize, service
from lrs.providers.base import FetchContext
from lrs.providers.mock import get_mock_providers


FAKE_APP = {
    "id": "11111111-1111-1111-1111-111111111111",
    "pan_number": "ABCDE1234F",
    "phone": "9876543210",
    "customer_name": "Test User",
    "loan_amount_requested": 500000,
    "monthly_gross_income": 80000,
    "monthly_net_income": 70000,
    "monthly_emi_existing": 12000,
    "repayment_period_years": 4,
    "purpose_of_loan": "home renovation and wedding",
}


def _run(coro):
    return asyncio.run(coro)


def test_score_application_full_result():
    r = _run(service.score_application(FAKE_APP))
    assert r["status"] == "scored"
    assert 0 <= r["total_score"] <= 100
    assert r["decision"] in ("approve", "refer", "reject")
    assert r["system_suggestion"] in ("approve", "review", "deny")
    assert r["recommended_amount"] >= 0
    assert r["interest_rate"] > 0
    assert set(r["pillar_scores"].keys()) == {
        "credit_bureau", "income", "bank_statement", "personal_profile", "loan_specific",
    }
    assert r["config_version"]


def test_deterministic_same_pan_same_score():
    a = _run(service.score_application(FAKE_APP))
    b = _run(service.score_application(FAKE_APP))
    assert a["total_score"] == b["total_score"]
    assert a["decision"] == b["decision"]


def test_uses_real_form_income():
    """Mock income provider should surface the form's net income."""
    r = _run(service.score_application(FAKE_APP))
    assert r["canonical_inputs"]["net_monthly_income"] == 70000.0


def test_normalize_derives_loan_specific():
    inputs = normalize.to_canonical_inputs(FAKE_APP, [{"annual_income": 840000}])
    # purpose "home renovation..." → 'home' keyword → home_loan
    assert inputs["loan_purpose"] == "home_loan"
    assert inputs["secured_unsecured"] == "secured"
    assert inputs["loan_to_income_x"] == round(500000 / 840000, 3)
    assert inputs["tenure_years"] == 4


def test_missing_provider_degrades_gracefully():
    """A provider returning {} must not crash the pipeline; score stays valid."""
    class EmptyBank:
        name = "bankstmt"; pillar = "bank_statement"
        async def fetch(self, ctx): return {}
    provs = [p for p in get_mock_providers() if p.name != "bankstmt"] + [EmptyBank()]
    r = _run(service.score_application(FAKE_APP, providers=provs))
    assert r["status"] == "scored"
    assert 0 <= r["total_score"] <= 100
    assert sum(r["effective_weights"].values()) == round(sum(r["effective_weights"].values()), 5)


def test_provider_exception_propagates_for_retry():
    """A transient provider error must propagate so the job worker retries."""
    class BoomBureau:
        name = "bureau"; pillar = "credit_bureau"
        async def fetch(self, ctx): raise RuntimeError("bureau 503")
    provs = [BoomBureau()] + [p for p in get_mock_providers() if p.name != "bureau"]
    try:
        _run(service.score_application(FAKE_APP, providers=provs))
        assert False, "expected exception to propagate"
    except RuntimeError as e:
        assert "503" in str(e)


def test_product_selection_consumer_for_auto():
    app = dict(FAKE_APP, purpose_of_loan="new car purchase")
    di = normalize.decision_inputs(app, normalize.to_canonical_inputs(app, []))
    assert di["product_key"] == "consumer_loan"
