# Guarantor Consent Call System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jab loan form submit ho aur usme guarantor name+phone ho, ek automated outbound voice call guarantor ko lage jo consent (yes/no) record kare; result `loan_applications` pe mirror ho aur bank portal + ops mein dikhe.

**Architecture:** Approach B — isolated `guarantor_consent_calls` table + dedicated dispatch cron, jo low-level calling primitives (`_acquire_trunk_from_db`, `_release_trunk_to_db`, LiveKit room/dispatch/SIP) aur shared `agent_core` reuse karta hai. Existing customer `Dispatcher`, `agent_calls`, `agent_batches`, `/api/agent/transcript`, analytics cron — UNTOUCHED.

**Tech Stack:** Python 3.11 / FastAPI / asyncpg / APScheduler / livekit-agents (Deepgram + Gemini/Groq + Sarvam) / Next.js 14 / PostgreSQL.

**Testing note (read first):** Is repo mein project-level test harness NAHI hai (no pytest/conftest). Per Adil's CLAUDE.md Rule 2, verification = compile/import checks + focused standalone async scripts for critical invariants + curl against endpoints + `npx tsc --noEmit` + documented manual e2e. **Spec:** `docs/superpowers/specs/2026-06-12-guarantor-consent-call-design.md`.

**Repo root for all paths:** `C:\Users\adil.sheikh\Desktop\form\form`
**Branch discipline:** Work on a feature branch `feat/guarantor-consent`. Do NOT push to `master` until the whole plan is verified (push to master auto-deploys via CI/CD).

---

## File Structure

**New files:**
- `database/migration_v17_guarantor_consent.sql` — new table + 2 loan_applications columns.
- `backend/guarantor/__init__.py` — package marker.
- `backend/guarantor/trigger.py` — `enqueue_guarantor_consent_call(...)` (called from submit endpoints).
- `backend/guarantor/dispatch.py` — `dispatch_guarantor_call(row)` (one call: claim → trunk → LiveKit → SIP → bounded wait → finally release).
- `backend/guarantor/runner.py` — `process_guarantor_run()` (cron: gate → fetch eligible → concurrency-capped dispatch).
- `backend/guarantor/routes.py` — `/api/guarantor/consent` + `/api/guarantor/transcript` (APIRouter).
- `agent/prompts_guarantor.py` — `build_guarantor_consent_instructions(session)` (Hindi/English/Marathi).
- `agent/guarantor_consent.py` — entry-point shim (`AGENT_NAME=guarantor-consent`).
- `deploy/los-agent-guarantor.service` — systemd unit (or document inline for ops).
- `scripts/verify_guarantor_claim_release.py` — standalone invariant test for the critical trunk-release/claim logic.

**Modified files:**
- `backend/main.py` — 2 submit endpoints (additive enqueue block) + register guarantor router.
- `backend/agent/batch.py` — `agent_startup()` add_job for guarantor cron.
- `agent/agent_core.py` — entrypoint: 3rd branch (guarantor instructions + minimal tools).
- `agent/session.py` — `__init__` additive attrs + `_send_transcript` guarantor URL/payload branch.
- `agent/tools.py` — new `record_guarantor_consent` function tool.
- `scripts/deploy.sh` — add `los-agent-guarantor` to restart list + health gate.
- `frontend/app/bank/applications/[id]/page.tsx` — Consent field in Guarantor section.
- `frontend/components/ops/CallDetailDialog.tsx` — Guarantor Consent badge + interface field.

---

## Task 1: Database migration (table + mirror columns)

**Files:**
- Create: `database/migration_v17_guarantor_consent.sql`

- [ ] **Step 1: Write the migration**

Create `database/migration_v17_guarantor_consent.sql`:

```sql
-- migration_v17_guarantor_consent.sql
-- Guarantor consent call system: isolated table + mirror columns on loan_applications.
-- Idempotent (IF NOT EXISTS) — safe to re-run.

CREATE TABLE IF NOT EXISTS guarantor_consent_calls (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id  UUID NOT NULL UNIQUE REFERENCES loan_applications(id) ON DELETE CASCADE,
    bank_id         UUID,
    bank_name       TEXT,
    guarantor_name  VARCHAR(255),
    guarantor_phone VARCHAR(20),
    borrower_name   VARCHAR(255),
    loan_amount     NUMERIC,
    language        VARCHAR(30) DEFAULT 'hindi',
    status          VARCHAR(30) DEFAULT 'pending',   -- pending|calling|completed|no_answer|failed
    consent         VARCHAR(10),                     -- yes|no|NULL
    consent_note    TEXT,
    room_name       VARCHAR(255),
    recording_url   TEXT,
    transcript      JSONB DEFAULT '[]'::jsonb,
    retry_count     INTEGER DEFAULT 0,
    scheduled_at    TIMESTAMPTZ DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    ended_at        TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gcc_status_scheduled
    ON guarantor_consent_calls (status, scheduled_at);

ALTER TABLE loan_applications
    ADD COLUMN IF NOT EXISTS guarantor_consent     VARCHAR(10),
    ADD COLUMN IF NOT EXISTS guarantor_consent_at  TIMESTAMPTZ;
```

- [ ] **Step 2: Apply to local/staging DB and verify**

Run (adjust DSN to local Postgres, db `los_form`, port 5434 per project):

```bash
psql "postgresql://<user>:<pass>@127.0.0.1:5434/los_form" -f database/migration_v17_guarantor_consent.sql
```

Verify columns/table exist:

```bash
psql "postgresql://<user>:<pass>@127.0.0.1:5434/los_form" -c "\d guarantor_consent_calls"
psql "postgresql://<user>:<pass>@127.0.0.1:5434/los_form" -c "SELECT column_name FROM information_schema.columns WHERE table_name='loan_applications' AND column_name LIKE 'guarantor_consent%';"
```

Expected: table description prints all columns; the second query returns `guarantor_consent` and `guarantor_consent_at`.

- [ ] **Step 3: Commit**

```bash
git add database/migration_v17_guarantor_consent.sql
git commit -m "feat(db): guarantor_consent_calls table + loan_applications mirror columns (v17)"
```

---

## Task 2: Submit-time trigger (enqueue guarantor call)

**Files:**
- Create: `backend/guarantor/__init__.py`, `backend/guarantor/trigger.py`
- Modify: `backend/main.py` (after line 2463; after line 3160)

- [ ] **Step 1: Create package marker**

Create `backend/guarantor/__init__.py` (empty file).

- [ ] **Step 2: Write the trigger helper**

Create `backend/guarantor/trigger.py`:

```python
# backend/guarantor/trigger.py
"""Enqueue a guarantor consent call when a loan form is submitted with guarantor details.

Best-effort + additive: any failure here MUST NOT break form submission.
"""
import logging

logger = logging.getLogger("guarantor-trigger")


def _digits(s) -> str:
    return "".join(c for c in str(s or "") if c.isdigit())


async def enqueue_guarantor_consent_call(db_pool, application_id) -> None:
    """Upsert a guarantor_consent_calls row for the given loan application.

    Rules (see spec): skip if no guarantor details; skip if guarantor phone ==
    customer phone; resolve language (via linked agent_call) + bank_name; upsert
    keyed by application_id; re-call on changed number only if not yet completed.
    """
    app = await db_pool.fetchrow(
        """SELECT id, bank_id, customer_name, phone, guarantor_name, guarantor_phone,
                  loan_amount_requested, agent_call_id
             FROM loan_applications WHERE id = $1""",
        application_id,
    )
    if not app:
        return

    g_name = (app["guarantor_name"] or "").strip()
    g_phone_digits = _digits(app["guarantor_phone"])
    if not g_name or not g_phone_digits:
        logger.info("Guarantor enqueue skipped (no guarantor details) app=%s", application_id)
        return

    if g_phone_digits[-10:] == _digits(app["phone"])[-10:] and len(g_phone_digits) >= 10:
        logger.warning("Guarantor phone == customer phone; skipping app=%s", application_id)
        return

    # Resolve language from the linked agent_call (else hindi).
    language = "hindi"
    if app["agent_call_id"]:
        lang_row = await db_pool.fetchrow(
            "SELECT language FROM agent_calls WHERE id = $1", app["agent_call_id"]
        )
        if lang_row and lang_row["language"]:
            language = lang_row["language"]

    # Resolve bank name (else ABC Bank).
    bank_name = "ABC Bank"
    if app["bank_id"]:
        b = await db_pool.fetchrow("SELECT name FROM banks WHERE id = $1", app["bank_id"])
        if b and b["name"]:
            bank_name = b["name"]

    existing = await db_pool.fetchrow(
        "SELECT id, status, guarantor_phone FROM guarantor_consent_calls WHERE application_id = $1",
        application_id,
    )

    if existing is None:
        await db_pool.execute(
            """INSERT INTO guarantor_consent_calls
                 (application_id, bank_id, bank_name, guarantor_name, guarantor_phone,
                  borrower_name, loan_amount, language, status, scheduled_at, created_at, updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',NOW(),NOW(),NOW())""",
            application_id, app["bank_id"], bank_name, g_name, g_phone_digits,
            app["customer_name"], app["loan_amount_requested"], language,
        )
        # Mirror initial state.
        await db_pool.execute(
            "UPDATE loan_applications SET guarantor_consent = 'pending' WHERE id = $1",
            application_id,
        )
        logger.info("Guarantor consent call enqueued app=%s", application_id)
        return

    # Row exists: re-call only if not yet completed AND number changed.
    if existing["status"] != "completed" and _digits(existing["guarantor_phone"]) != g_phone_digits:
        await db_pool.execute(
            """UPDATE guarantor_consent_calls
                 SET guarantor_phone=$1, status='pending', retry_count=0,
                     scheduled_at=NOW(), updated_at=NOW()
               WHERE application_id=$2""",
            g_phone_digits, application_id,
        )
        await db_pool.execute(
            "UPDATE loan_applications SET guarantor_consent='pending' WHERE id=$1", application_id
        )
        logger.info("Guarantor consent call re-queued (number changed) app=%s", application_id)
```

- [ ] **Step 3: Wire into `/api/submit-form` (token endpoint)**

In `backend/main.py`, immediately AFTER line 2463 (`await record_transition(... "Form submitted by customer")`) and BEFORE line 2464 (`la = float(...)`), insert:

```python
    # Guarantor consent call (additive, best-effort — never block submission)
    try:
        from guarantor.trigger import enqueue_guarantor_consent_call
        await enqueue_guarantor_consent_call(db_pool, app_uuid)
    except Exception as e:
        logger.warning(f"Guarantor enqueue failed (non-blocking): {e}")
```

- [ ] **Step 4: Wire into `/api/submit-form-session` (session endpoint)**

In `backend/main.py`, immediately AFTER the transaction block closes (after line 3160, i.e. after the `async with conn.transaction()` block) and BEFORE the `# Send confirmation via AiSensy` comment (line 3161), insert:

```python
    # Guarantor consent call (additive, best-effort — never block submission)
    try:
        from guarantor.trigger import enqueue_guarantor_consent_call
        await enqueue_guarantor_consent_call(db_pool, app_row["id"])
    except Exception as e:
        logger.warning(f"Guarantor enqueue failed (non-blocking): {e}")
```

- [ ] **Step 5: Verify import + compile**

```bash
cd backend && python -c "import ast; ast.parse(open('guarantor/trigger.py',encoding='utf-8').read()); ast.parse(open('main.py',encoding='utf-8').read()); print('OK')"
```

Expected: `OK`.

- [ ] **Step 6: Functional verify (local DB)**

With local backend venv active and a local `loan_applications` row that has guarantor_name + guarantor_phone, run an ad-hoc script:

```bash
cd backend && python -c "
import asyncio, asyncpg, os
from guarantor.trigger import enqueue_guarantor_consent_call
async def main():
    pool = await asyncpg.create_pool(os.environ['DATABASE_URL'])
    app = await pool.fetchrow(\"SELECT id FROM loan_applications WHERE guarantor_name IS NOT NULL AND guarantor_phone IS NOT NULL LIMIT 1\")
    assert app, 'seed a loan_applications row with guarantor details first'
    await enqueue_guarantor_consent_call(pool, app['id'])
    row = await pool.fetchrow('SELECT status, guarantor_phone FROM guarantor_consent_calls WHERE application_id=$1', app['id'])
    print('enqueued row:', dict(row))
    assert row['status']=='pending'
asyncio.run(main())
"
```

Expected: prints a row with `status: pending`.

- [ ] **Step 7: Commit**

```bash
git add backend/guarantor/__init__.py backend/guarantor/trigger.py backend/main.py
git commit -m "feat(backend): enqueue guarantor consent call on form submit"
```

---

## Task 3: Guarantor dispatch (one call) — claim, trunk, LiveKit, SIP, finally-release

**Files:**
- Create: `backend/guarantor/dispatch.py`
- Reference (do NOT modify): `backend/services/dispatcher.py` (`_acquire_trunk_from_db`, `_release_trunk_to_db` are module-level; import them)

- [ ] **Step 1: Write the dispatch function**

Create `backend/guarantor/dispatch.py`:

```python
# backend/guarantor/dispatch.py
"""Dispatch ONE guarantor consent call. Mirrors the customer dispatcher's
acquire→dispatch→SIP→wait→RELEASE shape, but on the isolated guarantor table.

CRITICAL: the trunk MUST be released in `finally` (decrement active_calls),
else the shared phone pool leaks capacity and customer calls get starved.
"""
import os
import json
import time
import uuid
import asyncio
import logging

from livekit import api

from services.dispatcher import _acquire_trunk_from_db, _release_trunk_to_db

logger = logging.getLogger("guarantor-dispatch")

GUARANTOR_AGENT_NAME = os.getenv("GUARANTOR_AGENT_NAME", "guarantor-consent")
_WAIT_TIMEOUT_S = 370           # > agent safety_timeout (360s) so we never release mid-call
_POLL_INTERVAL_S = 3


async def _claim(db_pool, row_id) -> bool:
    """Atomic claim: only one runner tick wins pending→calling."""
    claimed = await db_pool.fetchval(
        """UPDATE guarantor_consent_calls
             SET status='calling', started_at=NOW(), updated_at=NOW()
           WHERE id=$1 AND status='pending'
        RETURNING id""",
        row_id,
    )
    return claimed is not None


async def _wait_terminal(db_pool, row_id) -> str:
    """Poll until the webhook moves the row to a terminal state, or timeout."""
    deadline = time.monotonic() + _WAIT_TIMEOUT_S
    while time.monotonic() < deadline:
        st = await db_pool.fetchval("SELECT status FROM guarantor_consent_calls WHERE id=$1", row_id)
        if st in ("completed", "no_answer", "failed"):
            return st
        await asyncio.sleep(_POLL_INTERVAL_S)
    return "timeout"


async def dispatch_guarantor_call(db_pool, row: dict) -> None:
    row_id = row["id"]
    if not await _claim(db_pool, row_id):
        return  # another tick took it

    lk_url = os.environ["LIVEKIT_URL"]
    lk = api.LiveKitAPI(
        url=lk_url,
        api_key=os.environ["LIVEKIT_API_KEY"],
        api_secret=os.environ["LIVEKIT_API_SECRET"],
    )
    trunk = await _acquire_trunk_from_db(db_pool)
    success = False
    try:
        if not trunk:
            logger.error("No trunk available for guarantor call %s", row_id)
            await _mark_attempt(db_pool, row, terminal="failed")
            return

        room_name = f"gcc_{uuid.uuid4().hex[:6]}_{int(time.time())}"
        phone = str(row["guarantor_phone"])
        sip_phone = phone if phone.startswith("+") else f"+91{phone[-10:]}"
        name = row["guarantor_name"] or "Guarantor"

        await lk.room.create_room(api.CreateRoomRequest(
            name=room_name, empty_timeout=300, max_participants=3,
            metadata=json.dumps({
                "customer_name": name,                 # greeting target = guarantor
                "phone": phone,
                "call_id": str(row_id),
                "bank_id": str(row["bank_id"] or ""),
                "language": row["language"] or "hindi",
                "gender": "male",
                "agent_purpose": "guarantor_consent",
                "bank_name": row["bank_name"] or "ABC Bank",
                "borrower_name": row["borrower_name"] or "",
                "loan_amount": str(row["loan_amount"] or ""),
            }),
        ))
        await db_pool.execute(
            "UPDATE guarantor_consent_calls SET room_name=$1, updated_at=NOW() WHERE id=$2",
            room_name, row_id,
        )
        await lk.agent_dispatch.create_dispatch(
            api.CreateAgentDispatchRequest(room=room_name, agent_name=GUARANTOR_AGENT_NAME))

        sip_kwargs = dict(
            room_name=room_name, sip_trunk_id=trunk["trunk_id"], sip_call_to=sip_phone,
            participant_identity=f"guarantor_{name.replace(' ', '_').replace('/', '_')}",
            participant_name=name, play_ringtone=True,
        )
        if trunk.get("phone_number"):
            sip_kwargs["sip_number"] = trunk["phone_number"]
        await lk.sip.create_sip_participant(api.CreateSIPParticipantRequest(**sip_kwargs))

        terminal = await _wait_terminal(db_pool, row_id)
        if terminal == "completed":
            success = True
        elif terminal in ("no_answer", "failed"):
            pass  # webhook already set it
        else:  # timeout
            await _mark_attempt(db_pool, row, terminal="no_answer")
    except Exception as e:
        logger.error("Guarantor dispatch error %s: %s", row_id, e, exc_info=True)
        await _mark_attempt(db_pool, row, terminal="failed")
    finally:
        if trunk:
            try:
                await _release_trunk_to_db(db_pool, trunk, success=success)
            except Exception as e:
                logger.error("Trunk release failed for %s: %s", row_id, e)
        try:
            await lk.aclose()
        except Exception:
            pass


async def _mark_attempt(db_pool, row: dict, terminal: str) -> None:
    """Apply retry/backoff. If retries remain, go back to pending with backoff;
    else leave terminal (consent stays whatever was captured / NULL)."""
    max_retries = int(os.getenv("GUARANTOR_MAX_RETRIES", "3"))
    attempt = (row["retry_count"] or 0) + 1
    backoff_min = {1: 5, 2: 15}.get(attempt, 30)
    if attempt < max_retries:
        await db_pool.execute(
            """UPDATE guarantor_consent_calls
                 SET status='pending', retry_count=$1,
                     scheduled_at=NOW() + ($2 || ' minutes')::interval, updated_at=NOW()
               WHERE id=$3""",
            attempt, str(backoff_min), row["id"],
        )
    else:
        await db_pool.execute(
            """UPDATE guarantor_consent_calls
                 SET status=$1, retry_count=$2, ended_at=NOW(), updated_at=NOW()
               WHERE id=$3""",
            terminal, attempt, row["id"],
        )
```

- [ ] **Step 2: Write the critical-invariant verification script**

Create `scripts/verify_guarantor_claim_release.py`:

```python
# scripts/verify_guarantor_claim_release.py
"""Standalone checks for the two correctness invariants that protect the
running system: (1) only one tick claims a pending row, (2) the trunk is
always released — even when LiveKit/SIP raises. Uses in-memory fakes; no DB
or LiveKit needed. Run: python scripts/verify_guarantor_claim_release.py
"""
import asyncio, sys, types

# --- fake db_pool ---
class FakePool:
    def __init__(self): self.status = "pending"; self.execs = []
    async def fetchval(self, q, *a):
        if "UPDATE guarantor_consent_calls" in q and "status='calling'" in q:
            if self.status == "pending":
                self.status = "calling"; return a[0]
            return None
        if "SELECT status" in q:
            return "completed"
        return None
    async def execute(self, q, *a): self.execs.append(q)

released = {"called": False, "success": None}

async def fake_acquire(pool, *a, **k): return {"trunk_id": "t1", "phone_number": "+1999"}
async def fake_release(pool, trunk, success): released["called"] = True; released["success"] = success

# inject fakes into the module under test
import importlib
sys.modules["services"] = types.ModuleType("services")
disp_pkg = types.ModuleType("services.dispatcher")
disp_pkg._acquire_trunk_from_db = fake_acquire
disp_pkg._release_trunk_to_db = fake_release
sys.modules["services.dispatcher"] = disp_pkg

# fake livekit api that raises on create_room → forces the except+finally path
lk_api = types.ModuleType("api"); livekit_mod = types.ModuleType("livekit")
class _Boom:
    def __getattr__(self, n): raise RuntimeError("livekit down")
class _FakeAPI:
    def __init__(self, **k): self.room=_Boom()
    async def aclose(self): pass
lk_api.LiveKitAPI = _FakeAPI
livekit_mod.api = lk_api
sys.modules["livekit"] = livekit_mod
sys.modules["livekit.api"] = lk_api

import os
os.environ.setdefault("LIVEKIT_URL","x"); os.environ.setdefault("LIVEKIT_API_KEY","x"); os.environ.setdefault("LIVEKIT_API_SECRET","x")

# import target after fakes are in place
sys.path.insert(0, "backend")
dispatch = importlib.import_module("guarantor.dispatch")

async def main():
    pool = FakePool()
    row = {"id":"r1","guarantor_phone":"9876543210","guarantor_name":"G",
           "bank_id":None,"language":"hindi","bank_name":"ABC","borrower_name":"B",
           "loan_amount":None,"retry_count":0}
    # claim succeeds once
    assert await dispatch._claim(pool, "r1") is True
    assert await dispatch._claim(pool, "r1") is False, "second claim must fail"
    # full dispatch with LiveKit raising → must still release trunk
    pool2 = FakePool()
    await dispatch.dispatch_guarantor_call(pool2, row)
    assert released["called"] is True, "TRUNK LEAK: release not called on exception"
    print("OK: claim-once + finally-release invariants hold")

asyncio.run(main())
```

- [ ] **Step 3: Run the verification script**

```bash
python scripts/verify_guarantor_claim_release.py
```

Expected: `OK: claim-once + finally-release invariants hold`. (If it prints "TRUNK LEAK", the finally is broken — fix before continuing.)

- [ ] **Step 4: Compile check**

```bash
cd backend && python -c "import ast; ast.parse(open('guarantor/dispatch.py',encoding='utf-8').read()); print('OK')"
```

Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add backend/guarantor/dispatch.py scripts/verify_guarantor_claim_release.py
git commit -m "feat(backend): guarantor call dispatch with atomic claim + guaranteed trunk release"
```

---

## Task 4: Guarantor runner + cron registration

**Files:**
- Create: `backend/guarantor/runner.py`
- Modify: `backend/agent/batch.py` (`agent_startup()` scheduler block)

- [ ] **Step 1: Write the runner**

Create `backend/guarantor/runner.py`:

```python
# backend/guarantor/runner.py
"""Cron-driven guarantor dispatch lane. Respects calling hours + emergency stop
(reused from agent.batch). Concurrency-capped so it can't starve customer calls
on the shared trunk pool.
"""
import os
import asyncio
import logging

from guarantor.dispatch import dispatch_guarantor_call

logger = logging.getLogger("guarantor-runner")

_CONCURRENCY = int(os.getenv("GUARANTOR_CONCURRENCY", "2"))


async def process_guarantor_run() -> None:
    from agent import state as _state
    from agent.batch import is_within_calling_hours, is_emergency_stop_active

    if not is_within_calling_hours():
        return
    try:
        if is_emergency_stop_active():
            return
    except TypeError:
        # is_emergency_stop_active may be async in this codebase
        if await is_emergency_stop_active():
            return

    rows = await _state.db_pool.fetch(
        """SELECT * FROM guarantor_consent_calls
             WHERE status='pending' AND scheduled_at <= NOW()
               AND retry_count < $1
             ORDER BY scheduled_at ASC
             LIMIT $2""",
        int(os.getenv("GUARANTOR_MAX_RETRIES", "3")),
        _CONCURRENCY,
    )
    if not rows:
        return

    sem = asyncio.Semaphore(_CONCURRENCY)

    async def _one(r):
        async with sem:
            await dispatch_guarantor_call(_state.db_pool, dict(r))

    await asyncio.gather(*[_one(r) for r in rows], return_exceptions=True)
    logger.info("Guarantor run dispatched %d call(s)", len(rows))
```

> **Note for implementer:** Open `backend/agent/batch.py` and confirm the exact import names/signatures of `is_within_calling_hours` and `is_emergency_stop_active` and whether `is_emergency_stop_active` is sync or async; the runner above tolerates both, but verify the import path (`from agent.batch import ...` vs `from batch import ...`) matches how other modules import it in this repo. Adjust the import to match.

- [ ] **Step 2: Register the cron in `agent_startup()`**

In `backend/agent/batch.py`, inside `agent_startup()` where the other `_scheduler.add_job(...)` calls live (next to `batch_runner` / `analytics_runner`), add:

```python
    from guarantor.runner import process_guarantor_run
    _scheduler.add_job(
        process_guarantor_run,
        CronTrigger(hour=_hour_expr, minute="*/3", timezone="Asia/Kolkata"),
        id="guarantor_runner",
        replace_existing=True,
    )
```

> Use the SAME `_hour_expr` (calling-hours expression) already computed in this function for `batch_runner`. If the variable has a different name in the file, reuse that one. Do not invent new hours.

- [ ] **Step 3: Compile check**

```bash
cd backend && python -c "import ast; ast.parse(open('guarantor/runner.py',encoding='utf-8').read()); ast.parse(open('agent/batch.py',encoding='utf-8').read()); print('OK')"
```

Expected: `OK`.

- [ ] **Step 4: Verify cron registers at startup (smoke)**

Start the backend locally (or on staging) and grep logs for the scheduler. Expected: APScheduler logs an `Added job "process_guarantor_run"` / job id `guarantor_runner`, and no import error from `guarantor.runner`.

```bash
# after starting backend:
journalctl -u los-backend --since "2 min ago" | grep -i guarantor   # on server
# or watch local stdout for guarantor_runner / no traceback
```

- [ ] **Step 5: Commit**

```bash
git add backend/guarantor/runner.py backend/agent/batch.py
git commit -m "feat(backend): guarantor dispatch cron (calling-hours gated, concurrency-capped)"
```

---

## Task 5: Backend webhooks (consent + transcript) with mirror

**Files:**
- Create: `backend/guarantor/routes.py`
- Modify: `backend/main.py` (register router near other routers)

- [ ] **Step 1: Write the router**

Create `backend/guarantor/routes.py`:

```python
# backend/guarantor/routes.py
"""Webhooks the guarantor agent posts to. No JWT (same trust model as
/api/agent/transcript). Mirrors consent onto loan_applications for display.
"""
import json
import uuid
import logging

from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional, List, Any

logger = logging.getLogger("guarantor-routes")
router = APIRouter()


def _norm_consent(v: Optional[str]) -> Optional[str]:
    s = (v or "").strip().lower()
    if s in ("yes", "y", "haan", "ho", "हाँ", "हो"):
        return "yes"
    if s in ("no", "n", "nahi", "नहीं", "नाही"):
        return "no"
    return None


class ConsentPayload(BaseModel):
    call_id: str
    consent: Optional[str] = ""
    note: Optional[str] = ""


class TranscriptPayload(BaseModel):
    room: Optional[str] = None
    call_id: str
    transcript: List[Any] = []
    recording_path: Optional[str] = None
    consent: Optional[str] = ""
    consent_note: Optional[str] = ""


async def _mirror(db_pool, row_id, consent):
    app_id = await db_pool.fetchval(
        "SELECT application_id FROM guarantor_consent_calls WHERE id=$1", row_id)
    if app_id:
        await db_pool.execute(
            """UPDATE loan_applications
                 SET guarantor_consent = COALESCE($1, 'pending'),
                     guarantor_consent_at = NOW()
               WHERE id=$2""",
            consent, app_id,
        )


@router.post("/consent")
async def guarantor_consent(data: ConsentPayload):
    from agent import state as _state
    try:
        row_id = uuid.UUID(data.call_id)
    except ValueError:
        return {"status": "error", "message": "bad call_id"}
    consent = _norm_consent(data.consent)
    await _state.db_pool.execute(
        """UPDATE guarantor_consent_calls
             SET consent=$1, consent_note=$2, updated_at=NOW()
           WHERE id=$3""",
        consent, data.note or None, row_id,
    )
    await _mirror(_state.db_pool, row_id, consent)
    return {"status": "ok", "consent": consent}


@router.post("/transcript")
async def guarantor_transcript(data: TranscriptPayload):
    from agent import state as _state
    from agent.state import RECORDING_BASE_URL  # reuse existing base url constant
    try:
        row_id = uuid.UUID(data.call_id)
    except ValueError:
        return {"status": "error", "message": "bad call_id"}

    recording_url = (
        f"{RECORDING_BASE_URL}{data.recording_path}"
        if data.recording_path and RECORDING_BASE_URL else None
    )
    consent = _norm_consent(data.consent)
    status = "completed" if data.transcript else "no_answer"

    await _state.db_pool.execute(
        """UPDATE guarantor_consent_calls SET
             transcript=$1, recording_url=COALESCE($2, recording_url),
             status=$3, ended_at=NOW(), updated_at=NOW(),
             consent=COALESCE($4, consent),
             consent_note=COALESCE($5, consent_note)
           WHERE id=$6""",
        json.dumps(data.transcript), recording_url, status,
        consent, (data.consent_note or None), row_id,
    )
    # Mirror final consent (use whatever is now on the row).
    final_consent = await _state.db_pool.fetchval(
        "SELECT consent FROM guarantor_consent_calls WHERE id=$1", row_id)
    await _mirror(_state.db_pool, row_id, final_consent)
    return {"status": "ok", "row": str(row_id), "call_status": status}
```

> **Implementer check:** confirm `RECORDING_BASE_URL` is importable from `agent.state` (the customer transcript route uses it — see `backend/agent/transcript.py` imports). If it lives elsewhere, import from the same place `transcript.py` does.

- [ ] **Step 2: Register the router in `main.py`**

In `backend/main.py`, where other routers are included (search for `app.include_router(`), add:

```python
from guarantor.routes import router as guarantor_router
app.include_router(guarantor_router, prefix="/api/guarantor", tags=["guarantor"])
```

- [ ] **Step 3: Compile check**

```bash
cd backend && python -c "import ast; ast.parse(open('guarantor/routes.py',encoding='utf-8').read()); ast.parse(open('main.py',encoding='utf-8').read()); print('OK')"
```

Expected: `OK`.

- [ ] **Step 4: Functional verify via curl**

Start backend locally. Seed a `guarantor_consent_calls` row (from Task 2 verify) and grab its `id`. Then:

```bash
curl -sk -X POST http://127.0.0.1:8200/api/guarantor/consent \
  -H 'Content-Type: application/json' \
  -d '{"call_id":"<ROW_ID>","consent":"haan","note":"agreed"}'
# Expect: {"status":"ok","consent":"yes"}

psql "$DATABASE_URL" -c "SELECT consent FROM guarantor_consent_calls WHERE id='<ROW_ID>';"
# Expect: yes
psql "$DATABASE_URL" -c "SELECT guarantor_consent FROM loan_applications WHERE id=(SELECT application_id FROM guarantor_consent_calls WHERE id='<ROW_ID>');"
# Expect: yes
```

- [ ] **Step 5: Commit**

```bash
git add backend/guarantor/routes.py backend/main.py
git commit -m "feat(backend): guarantor consent + transcript webhooks with loan_applications mirror"
```

---

## Task 6: Agent prompt (Hindi / English / Marathi)

**Files:**
- Create: `agent/prompts_guarantor.py`

- [ ] **Step 1: Write the prompt builder**

Create `agent/prompts_guarantor.py`:

```python
# -*- coding: utf-8 -*-
"""Guarantor consent agent — prompt builder (Hindi / Marathi / English).
The hardcoded greeting (in agent_core) already did intro + "Am I speaking with
{guarantor}?". This prompt opens AFTER identity is confirmed: explain context,
ask consent ONCE, record it, end. Minimal toolset: record_guarantor_consent, end_call.
"""


def build_guarantor_consent_instructions(session) -> str:
    name = session.customer_name          # guarantor's name (greeting target)
    borrower = getattr(session, "borrower_name", "") or "the applicant"
    agent = session.agent_name
    bank = session.bank_name
    lang = (session.language or "hindi").lower()

    if lang == "english":
        return f"""You are {agent} from {bank}, calling {name}.
The system greeting already confirmed identity. Do NOT re-introduce.

PURPOSE: {borrower} has named {name} as a guarantor for a loan application at {bank}.
You must explain this briefly and record whether {name} consents to be the guarantor.

FLOW:
1. If identity not yet clearly confirmed and they ask who/why → "I'm calling from {bank}. {borrower} has applied for a loan and listed you as their guarantor."
2. Explain in one line: "As a guarantor, you'd support this loan if needed. I just need your consent."
3. Ask ONCE: "Do you agree to be the guarantor for {borrower} — yes or no?"
   - Clear YES → call record_guarantor_consent with consent="yes". Then: "Thank you, I've noted your consent. Have a great day." → end_call.
   - Clear NO → call record_guarantor_consent with consent="no" and a short note of the reason if given. Then: "Understood, thank you for your time. Have a great day." → end_call.
   - Unclear / "let me think" / no clear answer after ONE rephrase → call record_guarantor_consent with consent="" and note the situation. Then politely close → end_call.
4. Wrong person / "not me" → call record_guarantor_consent with consent="" note="wrong person" → "Apologies for the inconvenience." → end_call.

RULES:
- Keep every response 1-2 short sentences. Warm, respectful, like a real bank associate.
- Ask for consent only ONCE (one rephrase max). Do not pressure.
- Never discuss loan amount details beyond the one-line context. No financial advice.
- After end_call say NOTHING.

TTS: no emoji, no slashes/pipes, numbers as words, Roman or Devanagari only."""

    if lang == "marathi":
        return f"""तुम्ही {agent}, {bank} मधून {name} यांना call करत आहात.
System greeting ने ओळख आधीच confirm केली आहे. पुन्हा introduction देऊ नका.

उद्देश: {borrower} यांनी {bank} मधील loan साठी {name} यांना guarantor म्हणून नाव दिले आहे.
हे थोडक्यात समजावा आणि {name} guarantor व्हायला सहमत आहेत का ते record करा.

FLOW:
1. कोण/का विचारल्यास → "मी {bank} मधून बोलतोय. {borrower} यांनी loan साठी apply केले असून तुमचे नाव guarantor म्हणून दिले आहे."
2. एका ओळीत समजावा: "Guarantor म्हणून तुम्ही गरज पडल्यास या loan ला support कराल. मला फक्त तुमची संमती हवी."
3. एकदाच विचारा: "तुम्ही {borrower} साठी guarantor व्हायला सहमत आहात का — हो की नाही?"
   - स्पष्ट हो → record_guarantor_consent ला consent="yes" ने call करा. मग: "धन्यवाद, तुमची संमती नोंदवली. दिवस चांगला जावो." → end_call.
   - स्पष्ट नाही → record_guarantor_consent ला consent="no" आणि कारण असल्यास note ने call करा. मग: "समजले, तुमच्या वेळाबद्दल धन्यवाद." → end_call.
   - अस्पष्ट / "विचार करून सांगतो" / एकदा rephrase नंतरही स्पष्ट नाही → record_guarantor_consent ला consent="" आणि note ने call करा. मग नम्रपणे संपवा → end_call.
4. चुकीची व्यक्ती → record_guarantor_consent consent="" note="wrong person" → "गैरसोयीबद्दल क्षमस्व." → end_call.

RULES:
- प्रत्येक response 1-2 छोटी वाक्ये. आदराने, खऱ्या bank associate सारखे.
- संमती फक्त एकदाच विचारा (जास्तीत जास्त एक rephrase). दबाव नको.
- Loan ची आर्थिक माहिती detail मध्ये देऊ नका. आर्थिक सल्ला नको.
- end_call नंतर काहीही बोलू नका.

TTS: emoji नाही, slash/pipe नाही, numbers शब्दांत, फक्त Devanagari किंवा Roman."""

    # Hindi (default)
    return f"""आप {agent} हैं, {bank} से {name} को call कर रहे हैं।
System greeting पहले ही पहचान confirm कर चुका है। दोबारा introduction मत दो।

उद्देश्य: {borrower} ने {bank} में एक loan के लिए {name} को guarantor के रूप में नाम दिया है।
इसे संक्षेप में समझाओ और record करो कि {name} guarantor बनने के लिए सहमत हैं या नहीं।

FLOW:
1. कौन/क्यों पूछें → "मैं {bank} से बोल रहा हूँ। {borrower} ने loan के लिए apply किया है और आपका नाम guarantor के रूप में दिया है।"
2. एक line में समझाओ: "Guarantor के तौर पर आप ज़रूरत पड़ने पर इस loan को support करेंगे। मुझे बस आपकी सहमति चाहिए।"
3. एक बार पूछो: "क्या आप {borrower} के लिए guarantor बनने को सहमत हैं — हाँ या ना?"
   - साफ़ हाँ → record_guarantor_consent को consent="yes" के साथ call करो। फिर: "धन्यवाद, आपकी सहमति note कर ली है। आपका दिन शुभ हो।" → end_call।
   - साफ़ ना → record_guarantor_consent को consent="no" और कारण हो तो note के साथ call करो। फिर: "समझ गया, आपके समय के लिए धन्यवाद।" → end_call।
   - अस्पष्ट / "सोचकर बताता हूँ" / एक बार rephrase के बाद भी साफ़ नहीं → record_guarantor_consent को consent="" और note के साथ call करो। फिर politely बंद करो → end_call।
4. गलत व्यक्ति → record_guarantor_consent consent="" note="wrong person" → "असुविधा के लिए क्षमा करें।" → end_call।

RULES:
- हर response 1-2 छोटे वाक्य। आदर से, असली bank associate की तरह।
- सहमति सिर्फ एक बार पूछो (ज़्यादा से ज़्यादा एक rephrase)। दबाव मत डालो।
- Loan की वित्तीय जानकारी detail में मत दो। कोई financial advice नहीं।
- end_call के बाद कुछ मत बोलो।

TTS: कोई emoji नहीं, slash/pipe नहीं, numbers शब्दों में, सिर्फ Devanagari या Roman।"""
```

- [ ] **Step 2: Verify it parses and returns expected content**

```bash
cd agent && python -c "import ast; ast.parse(open('prompts_guarantor.py',encoding='utf-8').read()); print('parse OK')"
cd agent && python -c "
import types
class S: pass
s=S(); s.customer_name='Ramesh'; s.borrower_name='Suresh'; s.agent_name='Amit'; s.bank_name='ABC Bank'; s.language='hindi'
import prompts_guarantor as p
out=p.build_guarantor_consent_instructions(s)
assert 'guarantor' in out.lower() and 'Suresh' in out and 'Ramesh' in out and 'record_guarantor_consent' in out
print('content OK')
"
```

Expected: `parse OK` then `content OK`.

- [ ] **Step 3: Commit**

```bash
git add agent/prompts_guarantor.py
git commit -m "feat(agent): guarantor consent prompt (hi/en/mr)"
```

---

## Task 7: Agent tool `record_guarantor_consent`

**Files:**
- Modify: `agent/tools.py`

- [ ] **Step 1: Add the tool**

Open `agent/tools.py`. Note the existing tools are decorated `@function_tool` and take `context: RunContext` and read `session = context.userdata["session"]` (see `collect_all_data`). Add a new tool following that exact pattern (place it near `collect_all_data`):

```python
@function_tool
async def record_guarantor_consent(
    context: RunContext,
    consent: str = "",
    note: str = "",
) -> str:
    """Record the guarantor's consent. consent must be 'yes', 'no', or '' (unclear).
    Call this exactly once, as soon as the guarantor gives a clear answer."""
    import aiohttp
    from config import BACKEND_URL
    session = context.userdata["session"]
    c = (consent or "").strip().lower()
    session.guarantor_consent = c if c in ("yes", "no") else None
    session.guarantor_consent_note = note or None
    logger.info(f"record_guarantor_consent: consent={session.guarantor_consent!r} note={note!r}")
    # Best-effort immediate post (robust against call drop); transcript webhook also carries it.
    try:
        async with aiohttp.ClientSession() as http:
            await http.post(
                f"{BACKEND_URL}/api/guarantor/consent",
                json={"call_id": session.call_id, "consent": consent, "note": note},
                timeout=aiohttp.ClientTimeout(total=8),
                ssl=False,
            )
    except Exception as e:
        logger.warning(f"immediate consent post failed (non-fatal): {e}")
    return "ok"
```

> **Implementer check:** confirm `logger`, `function_tool`, and `RunContext` are already imported at the top of `tools.py` (they are used by existing tools). If `function_tool`/`RunContext` are imported under different names, match the existing import.

- [ ] **Step 2: Verify import**

```bash
cd agent && python -c "import ast; ast.parse(open('tools.py',encoding='utf-8').read()); print('OK')"
```

Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add agent/tools.py
git commit -m "feat(agent): record_guarantor_consent tool"
```

---

## Task 8: Agent core + session branches

**Files:**
- Modify: `agent/agent_core.py` (entrypoint, ~lines 309-327)
- Modify: `agent/session.py` (`__init__`, `_send_transcript`)

- [ ] **Step 1: session.py — additive attrs**

In `agent/session.py` `__init__`, after line 64 (`self.bank_name = metadata.get("bank_name", "ABC Bank")`), add:

```python
        self.borrower_name = metadata.get("borrower_name", "")
        self.guarantor_consent = None
        self.guarantor_consent_note = None
```

Also, so the guarantor script has the amount, after the existing `self.loan_amount = None` line, set from metadata when provided:

```python
        if metadata.get("loan_amount"):
            self.loan_amount = metadata.get("loan_amount")
```

- [ ] **Step 2: session.py — `_send_transcript` guarantor branch**

In `agent/session.py` `_send_transcript`, at the very top of the method (after the `if self.transcript_sent:` guard returns), add a branch that diverts guarantor calls to the guarantor endpoint and returns early:

```python
        if self.agent_purpose == "guarantor_consent":
            recording_path = f"/recordings/{self.room_name}.ogg" if self.egress_id else None
            payload = {
                "room": self.room_name,
                "call_id": self.call_id,
                "transcript": self.transcript,
                "message_count": len(self.transcript),
                "recording_path": recording_path,
                "consent": self.guarantor_consent or "",
                "consent_note": self.guarantor_consent_note or "",
            }
            for attempt in range(3):
                try:
                    async with aiohttp.ClientSession() as http:
                        async with http.post(
                            f"{BACKEND_URL}/api/guarantor/transcript",
                            json=payload,
                            timeout=aiohttp.ClientTimeout(total=15),
                            ssl=False,
                        ) as resp:
                            if resp.status == 200:
                                self.transcript_sent = True
                                logger.info(f"Guarantor transcript saved ({len(self.transcript)} msgs)")
                                return
                            logger.error(f"Guarantor transcript {resp.status}: {await resp.text()}")
                except Exception as e:
                    logger.error(f"Guarantor transcript save failed (attempt {attempt+1}/3): {e}")
                    if attempt < 2:
                        await asyncio.sleep(1.0)
            logger.error(f"CRITICAL: guarantor transcript save failed for {self.room_name}")
            return
```

The existing loan payload/POST below this branch stays UNCHANGED.

- [ ] **Step 3: agent_core.py — guarantor branch (prompt + minimal tools)**

In `agent/agent_core.py`, the prompt-selection block is lines 309-319 and the agent is built at lines 321-327. Replace the selection + start so guarantor gets its own instructions AND a minimal toolset. Update imports at top (line 28-30 area) to also import the new prompt + tool:

```python
from tools import send_form_link, end_call, schedule_callback, collect_all_data, record_guarantor_consent
from prompts import build_loan_enquiry_instructions
from prompts_account import build_account_opening_instructions
from prompts_guarantor import build_guarantor_consent_instructions
```

Then replace lines 309-327 with:

```python
        agent_purpose = metadata.get("agent_purpose", "loan_enquiry")
        if agent_purpose == "guarantor_consent":
            instructions = build_guarantor_consent_instructions(session)
            agent_tools = [record_guarantor_consent, end_call]
        elif agent_purpose == "account_opening":
            instructions = build_account_opening_instructions(
                customer_name=session.customer_name,
                phone=session.phone,
                language=session.language,
                gender=session.gender,
                agent_name=session.agent_name,
            )
            agent_tools = [send_form_link, end_call, schedule_callback, collect_all_data]
        else:
            instructions = build_loan_enquiry_instructions(session)
            agent_tools = [send_form_link, end_call, schedule_callback, collect_all_data]

        await agent_session.start(
            room=ctx.room,
            agent=Agent(instructions=instructions, tools=agent_tools),
        )
```

- [ ] **Step 4: Verify compile**

```bash
cd agent && python -c "import ast; [ast.parse(open(f,encoding='utf-8').read()) for f in ('agent_core.py','session.py')]; print('OK')"
```

Expected: `OK`.

- [ ] **Step 5: Verify the transcript-URL branch picks the guarantor endpoint**

```bash
cd agent && python -c "
import asyncio, types, sys
# minimal fakes so session imports
class FakeRoom: name='gcc_test'
class FakeCtx:
    def __init__(self): self.room=FakeRoom()
import session as S
sess = S.LoanEnquirySession(FakeCtx(), {'agent_purpose':'guarantor_consent','call_id':'abc','customer_name':'G','borrower_name':'B'})
assert sess.agent_purpose=='guarantor_consent'
assert hasattr(sess,'guarantor_consent') and hasattr(sess,'borrower_name')
print('session guarantor attrs OK')
"
```

Expected: `session guarantor attrs OK`. (Full POST is exercised in the e2e task.)

- [ ] **Step 6: Commit**

```bash
git add agent/agent_core.py agent/session.py
git commit -m "feat(agent): guarantor_consent branch (prompt + minimal tools) + transcript routing"
```

---

## Task 9: New worker shim, systemd, deploy.sh, env

**Files:**
- Create: `agent/guarantor_consent.py`
- Create: `deploy/los-agent-guarantor.service`
- Modify: `scripts/deploy.sh`

- [ ] **Step 1: Entry-point shim**

Open `agent/union_bank_los.py` to copy its exact structure (the `while True: cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name=AGENT_NAME))` loop). Create `agent/guarantor_consent.py` mirroring it, changing only the agent name default:

```python
# -*- coding: utf-8 -*-
"""Entry point #3: Guarantor consent agent.
Delegates to the shared agent_core.entrypoint; behaviour is chosen by
metadata.agent_purpose == "guarantor_consent".
"""
import os
import time
import logging

from livekit.agents import cli, WorkerOptions
from agent_core import entrypoint

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("guarantor-consent-worker")

AGENT_NAME = os.getenv("GUARANTOR_AGENT_NAME", "guarantor-consent")

if __name__ == "__main__":
    while True:
        try:
            cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name=AGENT_NAME))
        except KeyboardInterrupt:
            break
        except Exception as e:
            logger.error(f"Worker crashed, restarting in 5s: {e}")
            time.sleep(5)
```

> **Implementer check:** match the EXACT imports/structure of `union_bank_los.py` (it may pass extra `WorkerOptions` args or set up logging differently). Copy that file and change only `AGENT_NAME`.

- [ ] **Step 2: systemd unit**

Create `deploy/los-agent-guarantor.service` (mirror the existing `los-agent-union` unit — confirm paths/venv against the running units on the server with `systemctl cat los-agent-union`):

```ini
[Unit]
Description=LOS Guarantor Consent Agent
After=network.target

[Service]
Type=simple
WorkingDirectory=/root/vaani_los_form/agent
EnvironmentFile=/root/vaani_los_form/agent/.env.local
ExecStart=/root/vaani_los_form/agent/venv/bin/python guarantor_consent.py start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: deploy.sh — add to restart + health**

Open `scripts/deploy.sh`. Find where `los-agent-union` and `los-agent-pusad` are restarted (the `--update` path). Add `los-agent-guarantor` to the same restart list. Example (match existing style exactly):

```bash
systemctl restart los-backend los-frontend los-agent-union los-agent-pusad los-agent-guarantor
```

If the script checks each agent is registered/active after restart, add the guarantor service to that check too.

- [ ] **Step 4: Add env var**

Add to `agent/.env.local` (on server) AND ensure backend env has it (the dispatch module reads `GUARANTOR_AGENT_NAME`):

```
GUARANTOR_AGENT_NAME=guarantor-consent
```

(Backend default is also `guarantor-consent` so they match if unset; setting explicitly avoids drift.)

- [ ] **Step 5: Verify shim parses**

```bash
cd agent && python -c "import ast; ast.parse(open('guarantor_consent.py',encoding='utf-8').read()); print('OK')"
```

Expected: `OK`.

- [ ] **Step 6: Commit**

```bash
git add agent/guarantor_consent.py deploy/los-agent-guarantor.service scripts/deploy.sh
git commit -m "feat(ops): guarantor consent worker shim + systemd unit + deploy wiring"
```

---

## Task 10: Frontend display (bank detail + ops badge)

**Files:**
- Modify: `frontend/app/bank/applications/[id]/page.tsx` (~lines 209-217, Guarantor section)
- Modify: `frontend/components/ops/CallDetailDialog.tsx` (interface + render)

- [ ] **Step 1: Bank app detail — add Consent field**

In `frontend/app/bank/applications/[id]/page.tsx`, the Guarantor section renders `Field label="Guarantor Name"` and `Field label="Guarantor Phone"` (around lines 210-216). Add a consent line inside the same section grid:

```tsx
      <Field
        label="Consent"
        value={
          app.guarantor_consent === 'yes' ? 'Yes' :
          app.guarantor_consent === 'no' ? 'No' :
          app.guarantor_consent === 'pending' ? 'Pending' : '—'
        }
      />
```

Also widen the section's render condition so it shows when consent exists even if name/phone are empty:

```tsx
{(app.guarantor_name || app.guarantor_phone || app.guarantor_consent) && (
```

> **Implementer check:** confirm the `app` object type includes `guarantor_consent` (add `guarantor_consent?: string` to that page's application interface/type if it's locally typed; if the page uses `any`/fetched JSON, the field will already flow through).

- [ ] **Step 2: Ops CallDetailDialog — interface + badge**

In `frontend/components/ops/CallDetailDialog.tsx`, add to the `CallDetail` interface:

```tsx
  guarantor_consent?: string;
```

And in the Guarantor render area (where `is_salaried` / `individual_purpose` `FactSmall`s are rendered — same pattern), add:

```tsx
        {data.guarantor_consent && (
          <FactSmall
            label="Guarantor consent"
            value={
              data.guarantor_consent === 'yes' ? 'Yes' :
              data.guarantor_consent === 'no' ? 'No' : 'Pending'
            }
          />
        )}
```

> **Implementer check:** the ops CallDetail loads from the agent_call. To surface the mirrored value here, the call-detail fetch must include the linked application's `guarantor_consent`. If the existing call-detail API (`GET /api/agent/call/{id}`) does NOT join `loan_applications.guarantor_consent`, either (a) add that single column to its SELECT/join, or (b) keep the ops display limited to the bank detail page from Step 1 and skip this badge. Prefer (a) — a one-column additive join — but confirm the query in `backend/agent/calls.py` before editing; do not refactor the query.

- [ ] **Step 3: Type-check the frontend**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no new type errors from the edited files. (Pre-existing unrelated errors, if any, are out of scope — confirm your edited files are clean.)

- [ ] **Step 4: Commit**

```bash
git add frontend/app/bank/applications/[id]/page.tsx frontend/components/ops/CallDetailDialog.tsx
# include backend/agent/calls.py if Step 2(a) was applied
git commit -m "feat(frontend): show guarantor consent in bank detail + ops call detail"
```

---

## Task 11: End-to-end verification (staging)

**Files:** none (verification only)

- [ ] **Step 1: Deploy the branch to staging / server (do NOT merge to master yet)**

Apply migration v17, deploy backend + frontend + the 3 agents (including new `los-agent-guarantor`). Confirm all 4 services active and the guarantor worker registered with LiveKit (its agent_name appears in worker logs).

```bash
systemctl status los-agent-guarantor   # active (running)
journalctl -u los-agent-guarantor --since "2 min ago"   # registered, no traceback
```

- [ ] **Step 2: Trigger a real consent call**

Use a test loan application with a guarantor phone you control. Submit the form (or set guarantor details + hit the submit endpoint). Within calling hours, within ~3 min the guarantor number should ring.

Verify the row progresses:

```bash
psql "$DATABASE_URL" -c "SELECT status, consent, retry_count, room_name FROM guarantor_consent_calls ORDER BY created_at DESC LIMIT 1;"
# pending → calling → completed; consent yes/no
```

- [ ] **Step 3: Answer and say "haan"** → confirm:
- `guarantor_consent_calls.consent = 'yes'`, `status = 'completed'`, `recording_url` set, transcript non-empty.
- `loan_applications.guarantor_consent = 'yes'`.
- Bank app detail page shows **Consent: Yes**; ops call detail shows the badge (if Step 2a applied).

- [ ] **Step 4: Verify trunk did not leak**

```bash
psql "$DATABASE_URL" -c "SELECT phone_number, active_calls FROM phone_numbers ORDER BY active_calls DESC;"
# active_calls must return to its baseline after the guarantor call ends (no stuck +1)
```

- [ ] **Step 5: Verify the running customer system is unaffected**

Confirm a normal customer batch call still dispatches and saves as before (run/observe one), and analytics cron still categorizes customer calls. No guarantor rows appear in `agent_calls`.

- [ ] **Step 6: Merge + deploy to production**

Once all above pass:

```bash
git checkout master && git merge --no-ff feat/guarantor-consent
git push origin master   # CI/CD auto-deploys
```

Watch the deploy + health gate; confirm all 4 agents active post-deploy.

---

## Notes for the implementer

- **Surgical only:** every edited line must trace to this plan. Do not refactor the existing `Dispatcher`, transcript webhook, analytics, or the two existing agents.
- **Order matters for verification but not for safety:** Tasks 1-5 (backend) can be verified without the agent; Tasks 6-9 (agent) without the frontend. The system only does real calls after Task 9 + migration are live.
- **If `is_emergency_stop_active` / `is_within_calling_hours` import paths differ** from `agent.batch`, fix the import in `runner.py` to match the repo's convention (other modules in `backend/` import these — copy their import style).
- **Recording base URL & trunk helpers:** verify `RECORDING_BASE_URL` (state.py) and `_acquire_trunk_from_db`/`_release_trunk_to_db` (services/dispatcher.py) names before wiring; they are the two reuse seams.
