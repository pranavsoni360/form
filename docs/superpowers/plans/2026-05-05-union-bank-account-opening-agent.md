# Union Bank Account Opening Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second voice agent that calls customers to open savings/current accounts at Union Bank of India, reusing the full existing infrastructure with zero changes to existing loan enquiry agent behaviour.

**Architecture:** Separate LiveKit worker process (`union-bank-account-opening`) + additive DB columns (`agent_type`) + new prompts file + new account-form frontend page. All existing loan agent code paths are unchanged; account opening is a parallel track selected by `agent_type` at upload time.

**Tech Stack:** Python 3.11, FastAPI, asyncpg/PostgreSQL, LiveKit agents SDK, Deepgram STT, Sarvam TTS, Gemini/Groq FallbackAdapter, AiSensy WhatsApp, Next.js 14 (App Router), TypeScript.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `database/migration_v5_agent_type.sql` | CREATE | ALTER TABLE — two additive columns |
| `backend/agent/state.py` | MODIFY | Add 2 constants + 2 fields to TranscriptPayload |
| `backend/agent/batch.py` | MODIFY | `agent_type` query param, store in DB, dispatch routing |
| `backend/agent/whatsapp.py` | MODIFY | Conditional form URL (account-form vs loan form) |
| `backend/agent/calls.py` | MODIFY | 3 new fields in form-data response |
| `agent/config.py` | MODIFY | Add UNION_BANK_NAME constant |
| `agent/session.py` | MODIFY | Add agent_purpose, bank_name, account_type_selected, initial_deposit |
| `agent/tools.py` | MODIFY | Add account_type + initial_deposit to collect_all_data |
| `agent/prompts_account.py` | CREATE | Account opening prompts — Hindi / Marathi / English |
| `agent/agent_core.py` | MODIFY | Branch on agent_purpose to pick instructions |
| `agent/union_bank_los.py` | CREATE | Thin entry point for Union Bank worker |
| `frontend/public/agent-dashboard.html` | MODIFY | Agent type dropdown in upload form |
| `frontend/app/bank/batch/page.tsx` | MODIFY | agentType state + dropdown + query param |
| `frontend/app/account-form/page.tsx` | CREATE | Account opening form (prefilled from call data) |

---

## Task 1: DB Migration — agent_type columns

**Files:**
- Create: `database/migration_v5_agent_type.sql`

- [ ] **Step 1: Write the migration**

```sql
-- database/migration_v5_agent_type.sql
-- Additive: existing rows default to 'loan_enquiry'. No data loss.

ALTER TABLE agent_calls
  ADD COLUMN IF NOT EXISTS agent_type VARCHAR(50) NOT NULL DEFAULT 'loan_enquiry';

ALTER TABLE agent_batches
  ADD COLUMN IF NOT EXISTS agent_type VARCHAR(50) NOT NULL DEFAULT 'loan_enquiry';
```

- [ ] **Step 2: Run the migration**

```bash
psql $DATABASE_URL -f database/migration_v5_agent_type.sql
```

Expected output:
```
ALTER TABLE
ALTER TABLE
```

- [ ] **Step 3: Verify columns exist**

```bash
psql $DATABASE_URL -c "\d agent_calls" | grep agent_type
psql $DATABASE_URL -c "\d agent_batches" | grep agent_type
```

Expected: both show `agent_type | character varying(50) | not null | 'loan_enquiry'::character varying`

- [ ] **Step 4: Commit**

```bash
git add database/migration_v5_agent_type.sql
git commit -m "feat: add agent_type column to agent_calls and agent_batches"
```

---

## Task 2: Backend state.py — constants + TranscriptPayload

**Files:**
- Modify: `backend/agent/state.py`

- [ ] **Step 1: Write the failing test**

Create file `backend/tests/test_state_agent_type.py`:

```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

def test_union_bank_constants_exist():
    from agent.state import UNION_BANK_AGENT_NAME, UNION_BANK_NAME
    assert UNION_BANK_AGENT_NAME == "union-bank-account-opening"
    assert UNION_BANK_NAME == "Union Bank of India"

def test_transcript_payload_has_account_fields():
    from agent.state import TranscriptPayload
    payload = TranscriptPayload(room="test-room")
    assert hasattr(payload, "account_type")
    assert hasattr(payload, "initial_deposit")
    assert payload.account_type is None
    assert payload.initial_deposit is None
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && python -m pytest tests/test_state_agent_type.py -v
```

Expected: FAIL with `ImportError: cannot import name 'UNION_BANK_AGENT_NAME'`

- [ ] **Step 3: Add constants to state.py**

In `backend/agent/state.py`, after line 34 (`AGENT_NAME = ...`), add:

```python
# Union Bank account-opening agent
UNION_BANK_AGENT_NAME = os.getenv("UNION_BANK_AGENT_NAME", "union-bank-account-opening")
UNION_BANK_NAME = "Union Bank of India"
```

- [ ] **Step 4: Add fields to TranscriptPayload**

In `backend/agent/state.py`, the `TranscriptPayload` class ends at line ~401 (`collected_address`). Append two lines before the closing of the class:

```python
    account_type: Optional[str] = None
    initial_deposit: Optional[str] = None
```

After the edit, `TranscriptPayload` ends like:
```python
    existing_emi: Optional[str] = None
    business_age: Optional[str] = None
    monthly_turnover: Optional[str] = None
    collected_address: Optional[str] = None
    account_type: Optional[str] = None
    initial_deposit: Optional[str] = None
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd backend && python -m pytest tests/test_state_agent_type.py -v
```

Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/agent/state.py backend/tests/test_state_agent_type.py
git commit -m "feat: add Union Bank constants and account fields to TranscriptPayload"
```

---

## Task 3: Backend batch.py — agent_type param + dispatch routing

**Files:**
- Modify: `backend/agent/batch.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_batch_agent_type.py`:

```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import asyncio, httpx
from httpx import AsyncClient, ASGITransport

async def _get_app():
    import main
    return main.app

def test_upload_accepts_agent_type_param():
    """upload-excel endpoint signature must accept agent_type query param."""
    import inspect
    from agent.batch import upload_excel
    sig = inspect.signature(upload_excel)
    assert "agent_type" in sig.parameters, "agent_type param missing from upload_excel"

def test_upload_defaults_to_loan_enquiry():
    import inspect
    from agent.batch import upload_excel
    sig = inspect.signature(upload_excel)
    default = sig.parameters["agent_type"].default
    # default may be a Query(...) object; extract the default value
    default_val = default.default if hasattr(default, "default") else default
    assert default_val == "loan_enquiry"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && python -m pytest tests/test_batch_agent_type.py -v
```

Expected: FAIL with `AssertionError: agent_type param missing from upload_excel`

- [ ] **Step 3: Add agent_type param to upload_excel signature**

In `backend/agent/batch.py`, the `upload_excel` function signature (around line 386):

```python
@router.post("/upload-excel")
async def upload_excel(
    file: UploadFile = File(...),
    language: str = Query("hindi", description="Agent language"),
    gender: str = Query("male", description="Agent voice gender"),
    agent_type: str = Query("loan_enquiry", description="loan_enquiry | account_opening"),
    background_tasks: BackgroundTasks = None,
):
```

- [ ] **Step 4: Store agent_type in agent_batches INSERT**

In `backend/agent/batch.py`, the `agent_batches` INSERT (around line 440):

```python
await _state.db_pool.execute(
    """INSERT INTO agent_batches (id, batch_id, bank_id, filename, total_records, completed, failed, status, uploaded_by, created_at, agent_type)
       VALUES ($1, $2, $3, $4, $5, 0, 0, 'pending', $6, $7, $8)""",
    batch_uuid, batch_id, bank_id_uuid, file.filename, len(records), uploaded_by_uuid, upload_time,
    agent_type.lower().strip(),
)
```

- [ ] **Step 5: Store agent_type in agent_calls INSERT**

In `backend/agent/batch.py`, the `agent_calls` INSERT (around line 462). Change to:

```python
await _state.db_pool.execute(
    """INSERT INTO agent_calls (
        id, bank_id, batch_id, customer_name, phone, loan_type, loan_amount,
        language, status, room_name, interested, form_sent,
        category, transcript, collected_data, created_at, updated_at, agent_type
    ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, 'Pending', $9, false, false,
        'Uncategorized', '[]'::jsonb, $10, $11, $11, $12
    )""",
    call_uuid,
    bank_id_uuid,
    batch_id,
    r.get("name", ""),
    phone,
    r.get("loan_type", "") or None,
    float(r["loan_amount"]) if r.get("loan_amount") and str(r["loan_amount"]).strip() else None,
    language.lower().strip(),
    room_name,
    json.dumps({
        "email": r.get("email", ""),
        "aadhar_number": r.get("aadhar_number", ""),
        "pan_number": r.get("pan_number", ""),
        "customer_type": r.get("customer_type", "new"),
        "gender": gender.lower().strip(),
    }),
    upload_time,
    agent_type.lower().strip(),
)
```

- [ ] **Step 6: Add conditional dispatch and room metadata**

In `backend/agent/batch.py`, the room creation block (around line 305). Change to:

```python
_call_agent_type = call.get("agent_type", "loan_enquiry")
_agent_name = UNION_BANK_AGENT_NAME if _call_agent_type == "account_opening" else AGENT_NAME
_metadata = {
    "customer_name": name,
    "phone": phone,
    "call_id": str(call_uuid),
    "bank_id": call.get("bank_id", ""),
    "language": call.get("language", "hindi"),
    "gender": customer_gender,
}
if _call_agent_type == "account_opening":
    _metadata["agent_purpose"] = "account_opening"
    _metadata["bank_name"] = UNION_BANK_NAME

await lk.room.create_room(api.CreateRoomRequest(
    name=room_name, empty_timeout=300, max_participants=3,
    metadata=json.dumps(_metadata),
))
await _state.db_pool.execute(
    "UPDATE agent_calls SET room_name = $1 WHERE id = $2",
    room_name, call_uuid,
)
await lk.agent_dispatch.create_dispatch(api.CreateAgentDispatchRequest(
    room=room_name, agent_name=_agent_name,
))
```

Also add the import at the top of batch.py where state constants are imported:

```python
from .state import (
    ..., UNION_BANK_AGENT_NAME, UNION_BANK_NAME,
)
```

Find the existing `from .state import (` block in batch.py and add `UNION_BANK_AGENT_NAME, UNION_BANK_NAME` to it.

- [ ] **Step 7: Run test to verify it passes**

```bash
cd backend && python -m pytest tests/test_batch_agent_type.py -v
```

Expected: PASS (2 tests)

- [ ] **Step 8: Commit**

```bash
git add backend/agent/batch.py backend/tests/test_batch_agent_type.py
git commit -m "feat: batch upload accepts agent_type param, routes dispatch to correct LiveKit agent"
```

---

## Task 4: Backend whatsapp.py + calls.py — form URL routing + form-data response

**Files:**
- Modify: `backend/agent/whatsapp.py`
- Modify: `backend/agent/calls.py`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_form_data_account.py`:

```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

def test_form_data_response_has_new_fields():
    """get_form_data must include account_type, initial_deposit, agent_type."""
    import ast, inspect
    from agent.calls import get_form_data
    src = inspect.getsource(get_form_data)
    assert '"account_type"' in src, "account_type missing from form-data response"
    assert '"initial_deposit"' in src, "initial_deposit missing from form-data response"
    assert '"agent_type"' in src, "agent_type missing from form-data response"

def test_whatsapp_reads_agent_type_from_call():
    """send_whatsapp_form must branch on agent_type."""
    import inspect
    from agent.whatsapp import send_whatsapp_form
    src = inspect.getsource(send_whatsapp_form)
    assert "account_opening" in src, "account_opening branch missing from send_whatsapp_form"
    assert "account-form" in src, "/account-form URL missing from send_whatsapp_form"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && python -m pytest tests/test_form_data_account.py -v
```

Expected: FAIL with `AssertionError: account_type missing from form-data response`

- [ ] **Step 3: Add 3 fields to get_form_data in calls.py**

In `backend/agent/calls.py`, `get_form_data` — the return dict currently ends at `"bank_id"`. Add 3 lines before the closing `}`:

```python
    return {
        "status": "success",
        "data": {
            "customer_name": call.get("customer_name", ""),
            "phone": call.get("phone", ""),
            "email": collected.get("email", ""),
            "aadhar_number": collected.get("aadhar_number", ""),
            "pan_number": collected.get("pan_number", ""),
            "customer_type": collected.get("customer_type", "new"),
            "loan_type": call.get("loan_type", ""),
            "loan_amount": call.get("loan_amount", ""),
            "employment_type": collected.get("employment_type", ""),
            "employer_name": collected.get("employer_name", ""),
            "monthly_income": collected.get("monthly_income", ""),
            "business_type": collected.get("business_type", ""),
            "age": collected.get("age", ""),
            "address": collected.get("collected_address", ""),
            "designation": collected.get("designation", ""),
            "loan_purpose": collected.get("loan_purpose", ""),
            "lead_quality": ca.get("lead_quality", ""),
            "call_status": call.get("status", ""),
            "bank_id": call.get("bank_id", ""),
            "account_type": collected.get("account_type", ""),
            "initial_deposit": collected.get("initial_deposit", ""),
            "agent_type": call.get("agent_type", "loan_enquiry"),
        },
    }
```

- [ ] **Step 4: Update whatsapp.py — conditional URL + skip loan_application for account_opening**

In `backend/agent/whatsapp.py`, replace the `form_url` construction block and the loan_application creation block. The full updated section (replace everything from `# ── 3. Create loan_application` to the end of the `if phone_norm:` block):

```python
    # ── 3. Determine agent type from call row ──
    _call_agent_type = "loan_enquiry"
    if call_row:
        _call_agent_type = call_row.get("agent_type") or "loan_enquiry"
        if isinstance(_call_agent_type, str):
            _call_agent_type = _call_agent_type.strip()

    # Build form URL based on agent type
    _digits = ''.join(c for c in (phone_norm or '') if c.isdigit())
    bare_phone = _digits[-10:] if len(_digits) >= 10 else _digits

    if _call_agent_type == "account_opening":
        # Account opening form — uses call_id directly, no loan_application needed
        form_url = (
            f"{FORM_BASE_URL}/account-form?call_id={call_id}"
            if call_id
            else f"{FORM_BASE_URL}/account-form"
        )
        app_id = None
    else:
        # Loan enquiry — existing OTP-based flow
        form_url = f"{FORM_BASE_URL}/?phone={bare_phone}" if bare_phone else f"{FORM_BASE_URL}/"
        app_id = None

        if phone_norm:
            existing_app = await _state.db_pool.fetchrow(
                "SELECT id FROM loan_applications WHERE phone = $1 AND status != 'submitted' ORDER BY created_at DESC LIMIT 1",
                phone_norm,
            )

            if existing_app:
                app_id = existing_app["id"]
                logger.info(f"Existing application found for {phone_norm}: {app_id}")
            else:
                loan_id = f"AGENT-{secrets.token_hex(4)}-{int(time.time())}"
                bank_id = None
                if call_row and call_row.get("bank_id"):
                    try:
                        bank_id = uuid.UUID(str(call_row["bank_id"])) if call_row["bank_id"] else None
                    except Exception:
                        pass

                def parse_num(val):
                    if not val:
                        return None
                    cleaned = "".join(c for c in str(val) if c.isdigit() or c == ".")
                    try:
                        return float(cleaned) if cleaned else None
                    except ValueError:
                        return None

                loan_amount = parse_num(call_row["loan_amount"] if call_row else None) or parse_num(collected.get("loan_amount"))
                monthly_income = parse_num(collected.get("monthly_income"))
                existing_emi = parse_num(collected.get("existing_emi"))

                try:
                    row = await _state.db_pool.fetchrow(
                        """INSERT INTO loan_applications (
                            customer_name, phone, loan_id, current_step, status, last_saved_at, bank_id,
                            agent_call_id, full_name, employer_name, designation, employment_type,
                            monthly_gross_income, monthly_emi_existing, current_address,
                            purpose_of_loan, loan_amount_requested, customer_type, industry_type
                        ) VALUES (
                            $1, $2, $3, 1, 'draft', $4, $5,
                            $6, $7, $8, $9, $10,
                            $11, $12, $13,
                            $14, $15, $16, $17
                        ) RETURNING id""",
                        customer_name or "Customer",
                        phone_norm,
                        loan_id,
                        now_ist(),
                        bank_id,
                        call_uuid,
                        customer_name or "",
                        collected.get("employer_name") or None,
                        collected.get("designation") or None,
                        collected.get("employment_type") or None,
                        monthly_income,
                        existing_emi,
                        collected.get("collected_address") or None,
                        collected.get("loan_purpose") or None,
                        loan_amount,
                        collected.get("customer_type") or "new",
                        collected.get("business_type") or None,
                    )
                    app_id = row["id"]
                    logger.info(f"Created loan_application {app_id} for {phone_norm} from call {call_id}")

                    source_fields = {}
                    field_map = {
                        "employer_name": collected.get("employer_name"),
                        "designation": collected.get("designation"),
                        "employment_type": collected.get("employment_type"),
                        "monthly_gross_income": str(monthly_income) if monthly_income else None,
                        "monthly_emi_existing": str(existing_emi) if existing_emi else None,
                        "current_address": collected.get("collected_address"),
                        "purpose_of_loan": collected.get("loan_purpose"),
                        "loan_amount_requested": str(loan_amount) if loan_amount else None,
                        "customer_type": collected.get("customer_type"),
                        "industry_type": collected.get("business_type"),
                        "customer_name": customer_name,
                        "full_name": customer_name,
                    }
                    for field, value in field_map.items():
                        if value and str(value).strip():
                            source_fields[field] = value
                    if source_fields:
                        await save_field_sources(app_id, "agent_call", source_fields)

                except Exception as e:
                    logger.error(f"Failed to create loan_application: {e}")

            if app_id and call_uuid:
                await _state.db_pool.execute(
                    "UPDATE agent_calls SET application_id = $1 WHERE id = $2",
                    app_id, call_uuid,
                )
```

- [ ] **Step 5: Run tests**

```bash
cd backend && python -m pytest tests/test_form_data_account.py -v
```

Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/agent/whatsapp.py backend/agent/calls.py backend/tests/test_form_data_account.py
git commit -m "feat: account opening uses /account-form URL, form-data returns account_type/initial_deposit"
```

---

## Task 5: Agent shared modules — config.py + session.py + tools.py

**Files:**
- Modify: `agent/config.py`
- Modify: `agent/session.py`
- Modify: `agent/tools.py`

- [ ] **Step 1: Write the failing tests**

Create `agent/tests/test_shared_modules.py`:

```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

def test_union_bank_name_in_config():
    from config import UNION_BANK_NAME
    assert UNION_BANK_NAME == "Union Bank of India"

def test_session_stores_agent_purpose():
    from unittest.mock import MagicMock
    from session import LoanEnquirySession
    ctx = MagicMock()
    ctx.room.name = "test-room"
    metadata = {
        "customer_name": "Test User", "phone": "9876543210",
        "call_id": "abc-123", "language": "hindi", "gender": "male",
        "agent_purpose": "account_opening", "bank_name": "Union Bank of India",
    }
    s = LoanEnquirySession(ctx, metadata)
    assert s.agent_purpose == "account_opening"
    assert s.bank_name == "Union Bank of India"

def test_session_defaults_for_loan_enquiry():
    from unittest.mock import MagicMock
    from session import LoanEnquirySession
    ctx = MagicMock()
    ctx.room.name = "test-room"
    s = LoanEnquirySession(ctx, {"customer_name": "Test", "phone": "9876543210"})
    assert s.agent_purpose == "loan_enquiry"
    assert s.bank_name == "Pusad Urban Bank"

def test_collect_all_data_has_account_fields():
    import inspect
    from tools import collect_all_data
    sig = inspect.signature(collect_all_data.func if hasattr(collect_all_data, "func") else collect_all_data)
    # The @function_tool decorator wraps — check underlying function
    import tools
    src = inspect.getsource(tools)
    assert "account_type" in src, "account_type missing from collect_all_data"
    assert "initial_deposit" in src, "initial_deposit missing from collect_all_data"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd agent && python -m pytest tests/test_shared_modules.py -v
```

Expected: FAIL — `ImportError: cannot import name 'UNION_BANK_NAME'`

- [ ] **Step 3: Add UNION_BANK_NAME to config.py**

In `agent/config.py`, add after the last line:

```python
UNION_BANK_NAME = "Union Bank of India"
```

Full updated `agent/config.py`:

```python
import os
import pytz

BACKEND_URL = os.getenv("BACKEND_URL", "http://127.0.0.1:8002")
IST = pytz.timezone("Asia/Kolkata")

LANG_CONFIG = {
    "hindi":   {"stt_lang": "hi", "tts_lang": "hi-IN"},
    "marathi": {"stt_lang": "hi", "tts_lang": "mr-IN"},
    "english": {"stt_lang": "en", "tts_lang": "en-IN"},
}

GENDER_CONFIG = {
    "male":   {"speaker": "shubh", "name": "Amit"},
    "female": {"speaker": "pooja", "name": "Priya"},
}

UNION_BANK_NAME = "Union Bank of India"


def normalize_mobile(mobile: str) -> str:
    mobile = mobile.strip()
    if mobile.startswith("+91"):
        return mobile[3:]
    if mobile.startswith("91") and len(mobile) == 12:
        return mobile[2:]
    return mobile
```

- [ ] **Step 4: Add agent_purpose and bank_name to LoanEnquirySession.__init__**

In `agent/session.py`, in `LoanEnquirySession.__init__`, after the `self.memory = metadata.get("memory", "")` line (line ~49), add:

```python
        self.agent_purpose = metadata.get("agent_purpose", "loan_enquiry")
        self.bank_name = metadata.get("bank_name", "Pusad Urban Bank")
        self.account_type_selected = metadata.get("account_type", "")
        self.initial_deposit = None
```

- [ ] **Step 5: Add account_type and initial_deposit to update_collected_data mapping**

In `agent/session.py`, `update_collected_data` method, in the `mapping` dict (around line 113), add two entries:

```python
        mapping = {
            "age": "age",
            "loan_type": "loan_type",
            "loan_amount": "loan_amount",
            "loan_purpose": "loan_purpose",
            "employment_type": "employment_type",
            "employer_name": "employer_name",
            "qualification": "qualification",
            "designation": "designation",
            "sector": "sector",
            "working_experience": "working_experience",
            "monthly_income": "monthly_income",
            "existing_emi": "existing_emi",
            "business_type": "business_type",
            "business_age": "business_age",
            "monthly_turnover": "monthly_turnover",
            "address": "collected_address",
            "account_type": "account_type_selected",
            "initial_deposit": "initial_deposit",
        }
```

- [ ] **Step 6: Add account_type and initial_deposit to _send_transcript payload**

In `agent/session.py`, `_send_transcript` method, in the `payload` dict. After `"collected_address": self.collected_address,` add:

```python
            "account_type": self.account_type_selected or None,
            "initial_deposit": str(self.initial_deposit) if self.initial_deposit else None,
```

- [ ] **Step 7: Add account_type and initial_deposit params to collect_all_data in tools.py**

In `agent/tools.py`, the `collect_all_data` function signature — add two params after `address: str = ""`:

```python
async def collect_all_data(
    context: RunContext,
    age: str = "",
    employment_type: str = "",
    employer_name: str = "",
    qualification: str = "",
    designation: str = "",
    sector: str = "",
    working_experience: str = "",
    existing_emi: str = "",
    monthly_income: str = "",
    loan_amount: str = "",
    loan_type: str = "",
    loan_purpose: str = "",
    business_type: str = "",
    business_age: str = "",
    monthly_turnover: str = "",
    address: str = "",
    account_type: str = "",
    initial_deposit: str = "",
) -> str:
```

Also update the `fields` dict inside `collect_all_data` to include the new fields:

```python
    fields = {
        "age": age, "employment_type": employment_type, "employer_name": employer_name,
        "qualification": qualification, "designation": designation, "sector": sector,
        "working_experience": working_experience, "existing_emi": existing_emi,
        "monthly_income": monthly_income, "loan_amount": loan_amount, "loan_type": loan_type,
        "loan_purpose": loan_purpose, "business_type": business_type, "business_age": business_age,
        "monthly_turnover": monthly_turnover, "address": address,
        "account_type": account_type, "initial_deposit": initial_deposit,
    }
```

- [ ] **Step 8: Run tests to verify they pass**

```bash
cd agent && python -m pytest tests/test_shared_modules.py -v
```

Expected: PASS (4 tests)

- [ ] **Step 9: Commit**

```bash
git add agent/config.py agent/session.py agent/tools.py agent/tests/test_shared_modules.py
git commit -m "feat: add agent_purpose/bank_name to session, account_type/initial_deposit to collect_all_data"
```

---

## Task 6: agent/prompts_account.py — Account opening prompts

**Files:**
- Create: `agent/prompts_account.py`

- [ ] **Step 1: Write the failing test**

Create `agent/tests/test_prompts_account.py`:

```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from unittest.mock import MagicMock

def _make_session(language, gender="male", customer_type="new"):
    from unittest.mock import MagicMock
    from session import LoanEnquirySession
    ctx = MagicMock()
    ctx.room.name = "test"
    return LoanEnquirySession(ctx, {
        "customer_name": "Ramesh", "phone": "9876543210",
        "language": language, "gender": gender,
        "customer_type": customer_type,
        "agent_purpose": "account_opening", "bank_name": "Union Bank of India",
    })

def test_hindi_prompt_contains_union_bank():
    from prompts_account import build_account_opening_instructions
    s = _make_session("hindi")
    result = build_account_opening_instructions(s)
    assert "Union Bank" in result
    assert len(result) > 200

def test_marathi_prompt_contains_union_bank():
    from prompts_account import build_account_opening_instructions
    s = _make_session("marathi")
    result = build_account_opening_instructions(s)
    assert "Union Bank" in result
    assert len(result) > 200

def test_english_prompt_contains_union_bank():
    from prompts_account import build_account_opening_instructions
    s = _make_session("english")
    result = build_account_opening_instructions(s)
    assert "Union Bank" in result
    assert len(result) > 200

def test_prompt_mentions_account_type_question():
    from prompts_account import build_account_opening_instructions
    s = _make_session("english")
    result = build_account_opening_instructions(s)
    assert "Savings" in result or "savings" in result
    assert "Current" in result or "current" in result
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd agent && python -m pytest tests/test_prompts_account.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'prompts_account'`

- [ ] **Step 3: Create agent/prompts_account.py**

```python
# -*- coding: utf-8 -*-
"""
Union Bank Account Opening Agent — Prompt builders (Hindi / Marathi / English).
"""

from datetime import datetime, timedelta
from config import IST


def build_account_opening_instructions(session) -> str:
    memory_block = (
        f"\n🧠 PAST CALL CONTEXT: {session.memory}\n"
        if session.memory else ""
    )
    _now = datetime.now(IST)
    _tomorrow = (_now + timedelta(days=1)).strftime("%Y-%m-%d")
    time_ctx = f"NOW(IST): {_now.strftime('%a %d %b %Y, %I:%M %p')} | Tomorrow: {_tomorrow} | Working hrs: 10:00–24:00 IST"

    if session.language == "english":
        return _build_english_prompt(session, memory_block, time_ctx, _tomorrow)
    if session.language == "marathi":
        return _build_marathi_prompt(session, memory_block, time_ctx, _tomorrow)
    return _build_hindi_prompt(session, memory_block, time_ctx, _tomorrow)


def _build_hindi_prompt(session, memory_block: str, time_ctx: str, _tomorrow: str) -> str:
    name = session.customer_name
    agent = session.agent_name

    return f"""आप {agent} हैं — Union Bank of India की account specialist। Customer: {name}।
{time_ctx}{memory_block}
⚠️ Greeting + पहचान पहले हो चुकी है। नाम दोबारा मत पूछो।

STYLE: Warm, professional, असली relationship manager जैसी। हर response 1 छोटा वाक्य (<15 शब्द)। एक बार में एक सवाल। जवाब सुनकर कभी-कभी हल्का acknowledgment ("जी", "ठीक है") — हर बार नहीं।

FLOW:
1. हाँ बोले → "क्या आपका पहले से Union Bank में कोई account है?"
2a. Account है → "बढ़िया! Savings या Current — कौन सा additional account चाहिए?"
2b. Account नहीं → "कोई बात नहीं। Personal use के लिए Savings, business के लिए Current। कौन सा suitable होगा?"
3. Account type confirm → "बस कुछ छोटे सवाल, फिर WhatsApp पर account opening form।"
4. एक-एक करके पूछो (कोई tool call नहीं — सिर्फ बातचीत):
   • "आपकी उम्र क्या है?"
   • "आप क्या काम करते हैं और किस कंपनी में?"
   • "आपकी qualifications क्या हैं?"
   • "कितने साल का experience है?"
   • "कोई existing loan या EMI चल रही है?"
   • "आपकी monthly income लगभग कितनी है?"
   • "account में कितना initial deposit करना चाहेंगे?"
   • "क्या यही WhatsApp number है?" (नहीं तो नया number लो)
5. WhatsApp confirm होते ही — TURN A: collect_all_data(...) call करो (सारे fields एक shot में, account_type और initial_deposit ज़रूर include करो)। फिर बोलो: "ठीक है {name} जी। आप account opening के लिए eligible हैं। मैं अभी WhatsApp पर form link भेज दूँ?"
6. हाँ बोले — TURN B: send_form_link(account_type, initial_deposit) call करो। फिर: "form link भेज दिया है। please form भर लीजिए।"
7. TURN C (skip मत करो): "धन्यवाद {name} जी, आपके समय के लिए। आपका दिन शुभ हो।" → तुरंत उसी response में end_call("interested") call करो।

⚠️ STEPS 5-6-7 अलग-अलग TURNS हैं। एक turn में सब नहीं।

RULES:
• Q&A (steps 1-4) में कोई tool call नहीं — सिर्फ बातचीत।
• Customer "नहीं" / interest नहीं → "कोई बात नहीं, धन्यवाद {name} जी।" → end_call("not_interested").
• Customer busy / "बाद में call करो" → "कब suitable होगा?" → ISO datetime (e.g. कल 10 AM → "{_tomorrow}T10:00:00+05:30") → schedule_callback(iso, "user_busy") → "ठीक है, उस समय call करूँगी।" → end_call("user_busy").
• Off-topic → 1 line में deflect, पिछला सवाल repeat करो।
• Time-waster → "क्या आप वाकई account खोलना चाहते हैं?" → जवाब के अनुसार end_call.
• end_call() के बाद कुछ मत बोलो। STOP.
• TTS: कोई emoji नहीं, कोई em-dash नहीं। सिर्फ ?, ., ।
• Tool नाम कभी मत बोलो।"""


def _build_marathi_prompt(session, memory_block: str, time_ctx: str, _tomorrow: str) -> str:
    name = session.customer_name
    agent = session.agent_name

    return f"""तुम्ही {agent} आहात — Union Bank of India ची account specialist. Customer: {name}.
{time_ctx}{memory_block}
⚠️ ओळख आधीच झाली आहे. नाव परत विचारू नका.

STYLE: Warm, professional, खरी relationship manager सारखी. प्रत्येक response 1 छोटे वाक्य (<15 शब्द). एका वेळी एक प्रश्न. कधीकधी हलकी acknowledgment ("हो", "ठीक आहे") — प्रत्येक वेळी नाही.

FLOW:
1. हो म्हणाले → "तुमचे आधीपासून Union Bank मध्ये कोणते account आहे का?"
2a. Account आहे → "छान! Savings किंवा Current — कोणते additional account हवे?"
2b. Account नाही → "काही हरकत नाही. वैयक्तिक वापरासाठी Savings, व्यवसायासाठी Current. कोणते suitable होईल?"
3. Account type confirm → "फक्त काही छोटे प्रश्न, मग WhatsApp वर account opening form."
4. एक एक करून विचारा (कोणतेही tool call नाही — फक्त संभाषण):
   • "तुमचे वय किती आहे?"
   • "तुम्ही काय काम करता आणि कोणत्या कंपनीत?"
   • "तुमची qualification काय आहे?"
   • "किती वर्षांचा experience आहे?"
   • "कोणता existing loan किंवा EMI चालू आहे का?"
   • "तुमची monthly income साधारण किती आहे?"
   • "account मध्ये किती initial deposit करणार आहात?"
   • "हाच WhatsApp number आहे का?" (नाही तर नवा number घ्या)
5. WhatsApp confirm होताच — TURN A: collect_all_data(...) call करा (सगळे fields एकत्र, account_type आणि initial_deposit नक्की include करा). मग म्हणा: "ठीक आहे {name}, तुम्ही account opening साठी eligible आहात. मी आत्ता WhatsApp वर form link पाठवू का?"
6. Customer हो म्हणाले — TURN B: send_form_link(account_type, initial_deposit) call करा. मग: "form link पाठवली आहे. कृपया form भरा."
7. TURN C (नक्की करा — skip करू नका): "धन्यवाद {name}, तुमच्या वेळाबद्दल. तुमचा दिवस चांगला जाऊ दे." → त्याच response मध्ये end_call("interested") call करा.

⚠️ STEPS 5-6-7 वेगळ्या TURNS आहेत. एकत्र करू नका.

RULES:
• Q&A (steps 1-4) मध्ये कोणतेही tool call नाही — फक्त संभाषण.
• Customer "नाही" / interest नाही → "काही हरकत नाही, धन्यवाद {name}." → end_call("not_interested").
• Customer busy / "नंतर call करा" → "कधी suitable होईल?" → ISO datetime (उद्या 10 AM → "{_tomorrow}T10:00:00+05:30") → schedule_callback(iso, "user_busy") → "ठीक आहे, त्या वेळी call करतो/करते." → end_call("user_busy").
• Off-topic → 1 ओळीत deflect करा, मग शेवटचा प्रश्न repeat करा.
• Time-waster → "तुम्हाला खरोखर account उघडायचे आहे का?" → उत्तरानुसार end_call.
• end_call() नंतर काहीही बोलू नका. STOP.
• TTS: कोणतेही emoji नाही, em-dash नाही. फक्त ?, ., ।
• Tool नावे कधीही बोलू नका."""


def _build_english_prompt(session, memory_block: str, time_ctx: str, _tomorrow: str) -> str:
    name = session.customer_name
    agent = session.agent_name

    return f"""You are {agent} — account specialist at Union Bank of India. Customer: {name}.
{time_ctx}{memory_block}
⚠️ Introduction and identity already done. Do NOT ask the name again.

STYLE: Warm, professional, like a real relationship manager. Max 15 words per response. One question at a time. Occasional light acknowledgment ("I see", "Got it") — not every turn.

FLOW:
1. Customer says yes → "Do you currently have an account with Union Bank of India?"
2a. Has account → "Great! Would you like to open an additional Savings or Current account?"
2b. No account → "No problem at all! Savings accounts are for personal use, Current for business. Which would suit you better?"
3. Account type confirmed → "Just a few quick questions, then I'll send the account opening form to your WhatsApp."
4. Ask one by one (no tool calls during Q&A — conversation only):
   • "How old are you?"
   • "What is your occupation and which company do you work for?"
   • "What are your educational qualifications?"
   • "How many years of work experience do you have?"
   • "Do you have any existing loans or EMIs?"
   • "What is your approximate monthly income?"
   • "How much are you planning to deposit initially?"
   • "Is this your WhatsApp number?" (if no, get the correct number)
5. Once WhatsApp confirmed — TURN A: silently call collect_all_data(...) with all collected fields at once (include account_type and initial_deposit). Then say: "You are eligible. Shall I send the account opening form to your WhatsApp right now?"
6. Customer says yes — TURN B: call send_form_link(account_type, initial_deposit). Then say: "I have sent the form link. Please fill it in at your convenience."
7. TURN C (mandatory, do not skip): Say "Thank you {name} for your time. Have a great day." — then immediately in the same response call end_call("interested").

⚠️ STEPS 5-6-7 are SEPARATE TURNS. Do not combine them.

RULES:
• No tool calls during Q&A (steps 1-4) — conversation only.
• Customer says no / not interested → "No problem at all, thank you {name}." → end_call("not_interested").
• Customer busy / "call later" → ask "When would be a convenient time?" → build ISO datetime (e.g. tomorrow 10am → "{_tomorrow}T10:00:00+05:30"; unclear → default tomorrow 10am) → schedule_callback(iso, "user_busy") → "I'll call you at that time." → end_call("user_busy").
• Off-topic questions → deflect in 1 line, then repeat the last question.
• Time-wasters → calmly ask "Are you genuinely interested in opening an account?" → end_call based on response.
• After end_call() say NOTHING. STOP.
• TTS: No emojis, no em-dashes, no empty lines. Only ?, ., !
• Never say tool names aloud."""
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd agent && python -m pytest tests/test_prompts_account.py -v
```

Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add agent/prompts_account.py agent/tests/test_prompts_account.py
git commit -m "feat: add account opening prompts for Hindi, Marathi, English (Union Bank)"
```

---

## Task 7: agent/agent_core.py branch + agent/union_bank_los.py entry point

**Files:**
- Modify: `agent/agent_core.py`
- Create: `agent/union_bank_los.py`

- [ ] **Step 1: Write the failing test**

Create `agent/tests/test_agent_core_branch.py`:

```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

def test_agent_core_imports_account_prompt():
    import agent_core
    import inspect
    src = inspect.getsource(agent_core)
    assert "build_account_opening_instructions" in src
    assert "agent_purpose" in src

def test_union_bank_los_exists():
    import importlib.util
    path = os.path.join(os.path.dirname(__file__), "..", "union_bank_los.py")
    assert os.path.exists(path), "union_bank_los.py does not exist"
    spec = importlib.util.spec_from_file_location("union_bank_los", path)
    mod = importlib.util.module_from_spec(spec)
    # Just check it parses without error
    spec.loader.exec_module(mod)
    assert hasattr(mod, "AGENT_NAME")
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd agent && python -m pytest tests/test_agent_core_branch.py -v
```

Expected: FAIL with `AssertionError: build_account_opening_instructions not in agent_core`

- [ ] **Step 3: Update agent/agent_core.py — add import and instructions branch**

At the top of `agent/agent_core.py`, change the import line from:

```python
from prompts import build_loan_enquiry_instructions
```

to:

```python
from prompts import build_loan_enquiry_instructions
from prompts_account import build_account_opening_instructions
```

In the `LoanEnquiryAgent.__init__` (around line 38), change:

```python
class LoanEnquiryAgent(Agent):
    def __init__(self, session: LoanEnquirySession):
        _instructions = (
            build_account_opening_instructions(session)
            if session.agent_purpose == "account_opening"
            else build_loan_enquiry_instructions(session)
        )
        super().__init__(
            instructions=_instructions,
            tools=[send_form_link, end_call, schedule_callback, collect_all_data],
        )
```

- [ ] **Step 4: Create agent/union_bank_los.py**

```python
# agent/union_bank_los.py
# Entry point for Union Bank of India — Account Opening Agent.
# Runs as a separate LiveKit worker alongside los_updated.py.
import os
import logging
import time

from dotenv import load_dotenv
from livekit.agents import WorkerOptions, cli

from agent_core import entrypoint

load_dotenv(".env.local")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)

AGENT_NAME = os.getenv("UNION_BANK_AGENT_NAME", "union-bank-account-opening")

if __name__ == "__main__":
    while True:
        try:
            logging.getLogger("union-bank-agent").info("Starting Union Bank Account Opening Agent Worker...")
            cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name=AGENT_NAME))
        except KeyboardInterrupt:
            logging.getLogger("union-bank-agent").info("Worker stopped by user")
            break
        except Exception as e:
            logging.getLogger("union-bank-agent").error(f"Worker crashed: {e}")
            logging.getLogger("union-bank-agent").info("Restarting in 5 seconds...")
            time.sleep(5)
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd agent && python -m pytest tests/test_agent_core_branch.py -v
```

Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add agent/agent_core.py agent/union_bank_los.py agent/tests/test_agent_core_branch.py
git commit -m "feat: agent_core branches on agent_purpose, add union_bank_los.py entry point"
```

---

## Task 8: Frontend agent-dashboard.html — agent type dropdown

**Files:**
- Modify: `frontend/public/agent-dashboard.html`

- [ ] **Step 1: Add agent type dropdown HTML**

In `frontend/public/agent-dashboard.html`, after the gender `<div>` block (around line 803), add:

```html
                    <div style="flex: 1;">
                        <label class="form-label" style="display: flex; align-items: center; gap: 0.5rem;">🏦 Agent
                            Type</label>
                        <select class="form-select" id="uploadAgentType">
                            <option value="loan_enquiry" selected>💰 Loan Enquiry — Pusad Urban Bank</option>
                            <option value="account_opening">🏦 Account Opening — Union Bank of India</option>
                        </select>
                    </div>
```

The HTML block after this step looks like:

```html
                <div style="display: flex; gap: 1.5rem; ...">
                    <div style="flex: 1;">
                        <!-- Language selector (existing) -->
                        <select class="form-select" id="uploadLanguage">...</select>
                    </div>
                    <div style="flex: 1;">
                        <!-- Gender selector (existing) -->
                        <select class="form-select" id="uploadGender">...</select>
                    </div>
                    <div style="flex: 1;">
                        <!-- NEW: Agent type selector -->
                        <select class="form-select" id="uploadAgentType">
                            <option value="loan_enquiry" selected>💰 Loan Enquiry — Pusad Urban Bank</option>
                            <option value="account_opening">🏦 Account Opening — Union Bank of India</option>
                        </select>
                    </div>
                </div>
```

- [ ] **Step 2: Update uploadFile() JS to include agent_type**

In `frontend/public/agent-dashboard.html`, in the `uploadFile` function (around line 1509), change the `fetch` URL:

```javascript
async function uploadFile(file) {
    const language = document.getElementById('uploadLanguage').value;
    const gender = document.getElementById('uploadGender').value;
    const agentType = document.getElementById('uploadAgentType').value;
    showToast(`Uploading file... (${language} / ${gender} / ${agentType})`, 'info');
    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await fetch(`${getApiUrl()}/api/agent/upload-excel?language=${encodeURIComponent(language)}&gender=${encodeURIComponent(gender)}&agent_type=${encodeURIComponent(agentType)}`, {
            method: 'POST',
            body: formData
        });
```

- [ ] **Step 3: Commit**

```bash
git add frontend/public/agent-dashboard.html
git commit -m "feat: add agent type dropdown to dashboard upload form"
```

---

## Task 9: Frontend batch/page.tsx — agent type dropdown

**Files:**
- Modify: `frontend/app/bank/batch/page.tsx`

- [ ] **Step 1: Add agentType state**

In `frontend/app/bank/batch/page.tsx`, after `const [gender, setGender] = useState('male');` (around line 18), add:

```typescript
  const [agentType, setAgentType] = useState('loan_enquiry');
```

- [ ] **Step 2: Add agent type to upload query string**

In `frontend/app/bank/batch/page.tsx`, `handleUpload` function (around line 58), change the `qs` line:

```typescript
      const qs = `language=${encodeURIComponent(language)}&gender=${encodeURIComponent(gender)}&agent_type=${encodeURIComponent(agentType)}`;
```

- [ ] **Step 3: Add agent type selector UI**

In `frontend/app/bank/batch/page.tsx`, after the gender `<div>` block (around line 151, after the `</div>` that closes the gender selector), add:

```tsx
          <div className="flex-1 min-w-[180px]">
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">🏦 Agent Type</label>
            <select
              value={agentType}
              onChange={e => setAgentType(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-white"
            >
              <option value="loan_enquiry">💰 Loan Enquiry — Pusad Urban Bank</option>
              <option value="account_opening">🏦 Account Opening — Union Bank of India</option>
            </select>
          </div>
```

- [ ] **Step 4: Commit**

```bash
git add frontend/app/bank/batch/page.tsx
git commit -m "feat: add agent type dropdown to batch upload page"
```

---

## Task 10: Frontend account-form/page.tsx — account opening form

**Files:**
- Create: `frontend/app/account-form/page.tsx`

- [ ] **Step 1: Create the account opening form page**

Create `frontend/app/account-form/page.tsx`:

```tsx
'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { API_URL } from '@/lib/api';
import { Building2, CheckCircle2, Loader2 } from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';

export default function AccountFormPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    }>
      <AccountForm />
    </Suspense>
  );
}

function AccountForm() {
  const searchParams = useSearchParams();
  const callId = searchParams.get('call_id');

  const [formData, setFormData] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!callId) {
      setLoading(false);
      setError('Invalid link. Please use the link sent to your WhatsApp.');
      return;
    }
    fetch(`${API_URL}/api/agent/form-data/${callId}`)
      .then(r => r.json())
      .then(d => {
        if (d.status === 'success') setFormData(d.data);
        else setError('Could not load your details. Please try again.');
      })
      .catch(() => setError('Connection error. Please check your internet and retry.'))
      .finally(() => setLoading(false));
  }, [callId]);

  const onChange = (field: string, value: string) =>
    setFormData((p: any) => ({ ...p, [field]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!callId) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(`${API_URL}/api/agent/submit-form/${callId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (res.ok) {
        setSubmitted(true);
      } else {
        const d = await res.json().catch(() => ({}));
        setError(d.detail || 'Submission failed. Please try again.');
      }
    } catch {
      setError('Connection error. Please check your internet and retry.');
    } finally {
      setSubmitting(false);
    }
  };

  const inp = "w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none";
  const lbl = "block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1";

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 dark:from-gray-900 dark:to-gray-950 flex items-center justify-center p-4">
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl p-8 max-w-md w-full text-center">
          <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Application Submitted!</h1>
          <p className="text-gray-600 dark:text-gray-400">
            Thank you, {formData.customer_name}. Your account opening request has been received.
            A Union Bank representative will contact you shortly.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-950 py-8 px-4">
      <div className="max-w-lg mx-auto">
        <div className="flex justify-end mb-4"><ThemeToggle /></div>

        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl p-6 sm:p-8">
          {/* Header */}
          <div className="text-center mb-6">
            <Building2 className="w-12 h-12 text-blue-600 mx-auto mb-3" />
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">Union Bank of India</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">Account Opening Form</p>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-400 text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Account type */}
            <div>
              <label className={lbl}>Account Type *</label>
              <select
                value={formData.account_type || ''}
                onChange={e => onChange('account_type', e.target.value)}
                className={inp}
                required
              >
                <option value="">Select account type...</option>
                <option value="savings">Savings Account — Personal Use</option>
                <option value="current">Current Account — Business Use</option>
              </select>
            </div>

            {/* Initial deposit */}
            <div>
              <label className={lbl}>Initial Deposit Amount (₹)</label>
              <input
                type="number"
                value={formData.initial_deposit || ''}
                onChange={e => onChange('initial_deposit', e.target.value)}
                className={inp}
                placeholder="e.g. 10000"
                min="0"
              />
            </div>

            {/* Personal details */}
            <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">Personal Details</p>
            </div>

            <div>
              <label className={lbl}>Full Name *</label>
              <input
                type="text"
                value={formData.customer_name || ''}
                onChange={e => onChange('customer_name', e.target.value)}
                className={inp}
                required
              />
            </div>

            <div>
              <label className={lbl}>Mobile Number</label>
              <input type="text" value={formData.phone || ''} className={`${inp} opacity-60`} readOnly />
            </div>

            <div>
              <label className={lbl}>Age</label>
              <input
                type="text"
                value={formData.age || ''}
                onChange={e => onChange('age', e.target.value)}
                className={inp}
                placeholder="e.g. 32"
              />
            </div>

            <div>
              <label className={lbl}>Address</label>
              <textarea
                value={formData.address || ''}
                onChange={e => onChange('address', e.target.value)}
                className={inp}
                rows={2}
                placeholder="Current residential address"
              />
            </div>

            {/* Employment */}
            <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">Employment Details</p>
            </div>

            <div>
              <label className={lbl}>Employment Type</label>
              <select
                value={formData.employment_type || ''}
                onChange={e => onChange('employment_type', e.target.value)}
                className={inp}
              >
                <option value="">Select...</option>
                <option value="salaried">Salaried</option>
                <option value="self_employed">Self Employed</option>
                <option value="business">Business Owner</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div>
              <label className={lbl}>Employer / Company Name</label>
              <input
                type="text"
                value={formData.employer_name || ''}
                onChange={e => onChange('employer_name', e.target.value)}
                className={inp}
                placeholder="Company or business name"
              />
            </div>

            <div>
              <label className={lbl}>Monthly Income (₹)</label>
              <input
                type="number"
                value={formData.monthly_income || ''}
                onChange={e => onChange('monthly_income', e.target.value)}
                className={inp}
                placeholder="e.g. 35000"
                min="0"
              />
            </div>

            <div>
              <label className={lbl}>Existing Monthly EMIs (₹)</label>
              <input
                type="number"
                value={formData.existing_emi || ''}
                onChange={e => onChange('existing_emi', e.target.value)}
                className={inp}
                placeholder="0 if none"
                min="0"
              />
            </div>

            {/* KYC */}
            <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">KYC Documents</p>
            </div>

            <div>
              <label className={lbl}>PAN Number</label>
              <input
                type="text"
                value={formData.pan_number || ''}
                onChange={e => onChange('pan_number', e.target.value.toUpperCase())}
                className={inp}
                placeholder="ABCDE1234F"
                maxLength={10}
              />
            </div>

            <div>
              <label className={lbl}>Aadhaar Number</label>
              <input
                type="text"
                value={formData.aadhar_number || ''}
                onChange={e => onChange('aadhar_number', e.target.value.replace(/\D/g, ''))}
                className={inp}
                placeholder="12-digit Aadhaar number"
                maxLength={12}
              />
            </div>

            <button
              type="submit"
              disabled={submitting || !formData.account_type}
              className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-semibold rounded-xl transition flex items-center justify-center gap-2 mt-2"
            >
              {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> Submitting...</> : 'Submit Application'}
            </button>

            <p className="text-xs text-center text-gray-400 dark:text-gray-500">
              Your details are secure and will only be used for account opening.
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify the page compiles**

```bash
cd frontend && npx tsc --noEmit 2>&1 | grep account-form
```

Expected: no output (no type errors in account-form/page.tsx)

- [ ] **Step 3: Commit**

```bash
git add frontend/app/account-form/page.tsx
git commit -m "feat: add account opening form page for Union Bank agent"
```

---

## Final verification checklist

After all tasks are complete, run this end-to-end smoke test:

- [ ] `cd backend && python -m pytest tests/ -v` — all tests pass
- [ ] `cd agent && python -m pytest tests/ -v` — all tests pass
- [ ] `cd frontend && npx tsc --noEmit` — no TypeScript errors
- [ ] Start Pusad Bank agent: `AGENT_NAME=pusad-bank-loan-enquiry-enhanced python agent/los_updated.py start`
- [ ] Start Union Bank agent: `UNION_BANK_AGENT_NAME=union-bank-account-opening python agent/union_bank_los.py start`
- [ ] Upload a test CSV via dashboard with `Agent Type = Account Opening` — verify `agent_type = account_opening` in DB
- [ ] Upload another test CSV with `Agent Type = Loan Enquiry` — verify `agent_type = loan_enquiry` in DB
- [ ] Open `http://localhost:3001/account-form?call_id=<uuid>` — form loads with prefilled data

---

## Deployment note

Add to server startup script (alongside existing Pusad Bank worker):

```bash
# Worker 1 — Pusad Urban Bank loan enquiry (existing, unchanged)
AGENT_NAME=pusad-bank-loan-enquiry-enhanced python agent/los_updated.py start &

# Worker 2 — Union Bank account opening (new)
UNION_BANK_AGENT_NAME=union-bank-account-opening python agent/union_bank_los.py start &
```

Both workers share `.env.local`. No port conflicts — LiveKit workers connect outbound.
