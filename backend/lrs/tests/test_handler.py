"""Handler orchestration tests using an in-memory fake asyncpg pool."""
import asyncio
import uuid

from lrs import handlers


APP_ID = uuid.UUID("22222222-2222-2222-2222-222222222222")

APP_ROW = {
    "id": APP_ID, "pan_number": "ABCDE1234F", "phone": "9876543210",
    "customer_name": "Test", "loan_amount_requested": 400000,
    "monthly_gross_income": 75000, "monthly_net_income": 65000,
    "monthly_emi_existing": 8000, "repayment_period_years": 4,
    "purpose_of_loan": "personal loan for travel",
}


class FakeConn:
    def __init__(self, pool):
        self.pool = pool

    async def execute(self, sql, *args):
        self.pool.executes.append((sql, args))

    def transaction(self):
        conn = self

        class _Txn:
            async def __aenter__(self_): return conn
            async def __aexit__(self_, *a): return False
        return _Txn()


class FakePool:
    def __init__(self, existing_status=None, app_row=APP_ROW):
        self.existing_status = existing_status
        self.app_row = app_row
        self.executes = []

    async def fetchrow(self, sql, *args):
        if "FROM lrs_scores" in sql:
            return {"status": self.existing_status} if self.existing_status else None
        if "FROM loan_applications" in sql:
            return dict(self.app_row) if self.app_row else None
        return None

    async def execute(self, sql, *args):
        self.executes.append((sql, args))

    def acquire(self):
        pool = self

        class _Acq:
            async def __aenter__(self_): return FakeConn(pool)
            async def __aexit__(self_, *a): return False
        return _Acq()


def _run(coro):
    return asyncio.run(coro)


def test_handler_scores_and_mirrors():
    pool = FakePool(existing_status=None)
    _run(handlers.lrs_score({"application_id": str(APP_ID)}, pool))
    sqls = " ".join(s for s, _ in pool.executes)
    assert "UPDATE lrs_scores SET" in sqls          # persisted result
    assert "status = 'fetching'" in sqls or "status='fetching'" in sqls
    assert "UPDATE loan_applications" in sqls        # mirrored headline
    # mirror carries a numeric score + a suggestion in the approve/review/deny set
    mirror = [a for s, a in pool.executes if "loan_applications" in s][-1]
    # args = (application_id, total_score, system_suggestion)
    assert mirror[2] in ("approve", "review", "deny")


def test_handler_idempotent_skip_when_scored():
    pool = FakePool(existing_status="scored")
    _run(handlers.lrs_score({"application_id": str(APP_ID)}, pool))
    # No persist should happen (already scored).
    assert not any("UPDATE lrs_scores SET" in s for s, _ in pool.executes)


def test_handler_missing_application_returns_none():
    pool = FakePool(existing_status=None, app_row=None)
    result = _run(handlers.run_and_persist(pool, APP_ID))
    assert result is None
