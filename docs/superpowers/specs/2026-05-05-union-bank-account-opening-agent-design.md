# Union Bank of India — Account Opening Voice Agent Design

**Goal:** Add a second voice agent that calls customers to help them open a new savings or current account at Union Bank of India, reusing the full existing infrastructure (LiveKit, Deepgram STT, Sarvam TTS, Gemini/Groq LLM, WhatsApp form, batch system, DB).

**Architecture:** Separate LiveKit worker process with a distinct `AGENT_NAME` (`union-bank-account-opening`). Shares all agent modules (`agent_core.py`, `session.py`, `tools.py`, `config.py`). New files: thin entry point + account-opening prompts. Backend and DB changes are purely additive — no existing columns removed or renamed.

**Tech Stack:** Same as loan agent — LiveKit, Deepgram nova-3 STT, Sarvam bulbul:v3 TTS, Gemini 2.5-flash / Groq llama-3.3 / Groq llama-3.1 FallbackAdapter, APScheduler batch runner, AiSensy WhatsApp, asyncpg / PostgreSQL.

---

## 1. Agent Layer

### New files

| File | Purpose |
|------|---------|
| `agent/union_bank_los.py` | Thin entry point. Sets `AGENT_NAME=union-bank-account-opening` via env var (`UNION_BANK_AGENT_NAME`). Starts LiveKit worker with same retry loop as `los_updated.py`. |
| `agent/prompts_account.py` | Account opening prompts for Hindi / Marathi / English. Same structure as `prompts.py`. |

### Modified files (minimal, additive)

**`agent/agent_core.py`**
- Reads `agent_purpose = metadata.get("agent_purpose", "loan_enquiry")` from room/job metadata.
- Picks instructions builder: `build_account_opening_instructions` if `agent_purpose == "account_opening"`, else `build_loan_enquiry_instructions`.
- No other changes.

**`agent/session.py`**
- `LoanEnquirySession.__init__` stores `self.agent_purpose = metadata.get("agent_purpose", "loan_enquiry")` and `self.bank_name = metadata.get("bank_name", "Pusad Urban Bank")`.
- Greeting and disconnect logic unchanged.

**`agent/tools.py`**
- `collect_all_data` gains two new optional string fields: `account_type: str = ""` and `initial_deposit: str = ""`.
- All 16 existing fields untouched. Account opening agent uses `account_type` + `initial_deposit`; loan agent ignores them (they stay `""`).

**`agent/config.py`**
- Adds `UNION_BANK_NAME = "Union Bank of India"` constant.

### Account opening conversation flow (all 3 languages)

```
GREETING (non-interruptible):
  "Hello, this is [AgentName] calling from Union Bank of India.
   This call is being recorded for quality purposes."

IDENTITY CHECK (interruptible):
  "Am I speaking with [CustomerName]?"

FLOW:
1. Customer confirms → "Do you currently have a savings or current account with Union Bank?"
2. Has account → "Wonderful! We actually have some new account upgrade benefits…
                  Are you interested in opening an additional account?"
   No account  → "No problem at all! I can help you open one right away.
                  We offer Savings accounts for personal use and Current accounts
                  for business — which would suit you better?"
3. Account type confirmed (Savings/Current) → "Perfect. I just need a few quick details,
   then I'll send the account opening form directly to your WhatsApp."
4. Collect one by one (no tool calls during Q&A):
   • Age
   • Occupation and company/employer name
   • Educational qualifications
   • Years of work experience
   • Any existing loans or EMIs
   • Monthly income
   • Expected initial deposit amount
   • "Is this your WhatsApp number?" (get correct number if not)
5. TURN A: collect_all_data(account_type=..., initial_deposit=..., age=..., ...)
   Then say: "You are eligible to open a [Savings/Current] account.
              Shall I send the form to your WhatsApp right now?"
6. TURN B: send_form_link(account_type, initial_deposit)
   Then say: "Form sent! Please fill it in at your convenience."
7. TURN C: "Thank you [Name] for your time. Have a great day."
           → end_call("interested")

NOT INTERESTED: end_call("not_interested")
BUSY / CALL LATER: schedule_callback(iso_datetime, "user_busy") → end_call("user_busy")
```

**Latency settings:** Identical to loan agent — `min_endpointing_delay=0.13`, `preemptive_generation=True`, `min_interruption_duration=0.35`, Silero VAD `activation_threshold=0.50`, Sarvam TTS `pace=1.06`. Target: 1–1.5s turn latency.

**Background audio:** Same `BuiltinAudioClip.OFFICE_AMBIENCE` at volume=0.15.

---

## 2. Database Changes

Two additive ALTER TABLE statements. No columns removed or renamed. All existing rows default to `'loan_enquiry'`.

```sql
ALTER TABLE agent_calls
  ADD COLUMN IF NOT EXISTS agent_type VARCHAR(50) NOT NULL DEFAULT 'loan_enquiry';

ALTER TABLE agent_batches
  ADD COLUMN IF NOT EXISTS agent_type VARCHAR(50) NOT NULL DEFAULT 'loan_enquiry';
```

`collected_data` JSONB already stores any key-value pair — `account_type` and `initial_deposit` land there automatically. No schema change needed.

---

## 3. Backend Changes

### `backend/agent/state.py`
Add two constants:
```python
UNION_BANK_AGENT_NAME = os.getenv("UNION_BANK_AGENT_NAME", "union-bank-account-opening")
UNION_BANK_NAME = "Union Bank of India"
```

### `backend/agent/batch.py`
Three additive changes:

1. `/upload-excel` query param:
```python
agent_type: str = Query("loan_enquiry", description="loan_enquiry | account_opening")
```

2. INSERT into `agent_calls` and `agent_batches` includes `agent_type`.

3. Dispatch picks correct LiveKit agent:
```python
_agent_name = UNION_BANK_AGENT_NAME if call.get("agent_type") == "account_opening" else AGENT_NAME
await lk.agent_dispatch.create_dispatch(
    api.CreateAgentDispatchRequest(room=room_name, agent_name=_agent_name)
)
```

Room metadata for account opening calls gains:
```json
{ "agent_purpose": "account_opening", "bank_name": "Union Bank of India" }
```

### `backend/agent/calls.py`
`/form-data/{id}` response adds three new fields (all other fields untouched, all use `.get(..., "")` guards):
```python
"account_type":    collected.get("account_type", ""),
"initial_deposit": collected.get("initial_deposit", ""),
"agent_type":      call.get("agent_type", "loan_enquiry"),
```

`loan_type`, `loan_amount`, `loan_purpose` remain in the response. For account opening calls they return `""` — no errors, no missing keys.

---

## 4. Frontend Changes

### Batch upload UI (`agent-dashboard.html` + `frontend/app/bank/batch/page.tsx`)
Add agent type dropdown:
```
Agent:  ○ Loan Enquiry — Pusad Urban Bank
        ○ Account Opening — Union Bank of India
```
Passes `&agent_type=account_opening` (or `loan_enquiry`) in the upload request.

### Customer-facing WhatsApp form
Reads `agent_type` from the prefill response:
- `agent_type === "account_opening"` → show `account_type` + `initial_deposit` fields; loan fields (`loan_type`, `loan_amount`, `loan_purpose`) hidden (not removed from DOM — just not displayed)
- `agent_type === "loan_enquiry"` → existing behaviour unchanged

All other fields (name, phone, age, income, employment, address, PAN, Aadhaar, existing EMI) shown for both agent types.

---

## 5. Deployment

Two separate processes on the server:

```bash
# Process 1 (existing — unchanged)
AGENT_NAME=pusad-bank-loan-enquiry-enhanced python agent/los_updated.py start

# Process 2 (new)
UNION_BANK_AGENT_NAME=union-bank-account-opening python agent/union_bank_los.py start
```

Both processes share the same `.env.local` / environment variables. No port conflicts — LiveKit workers connect outbound to the LiveKit server.

---

## 6. Files Summary

| File | Change |
|------|--------|
| `agent/union_bank_los.py` | **NEW** — thin entry point |
| `agent/prompts_account.py` | **NEW** — account opening prompts (Hindi/Marathi/English) |
| `agent/agent_core.py` | **MODIFY** — 4-line branch on `agent_purpose` |
| `agent/session.py` | **MODIFY** — store `agent_purpose` + `bank_name` from metadata |
| `agent/tools.py` | **MODIFY** — add `account_type` + `initial_deposit` to `collect_all_data` |
| `agent/config.py` | **MODIFY** — add `UNION_BANK_NAME` constant |
| `backend/agent/state.py` | **MODIFY** — add `UNION_BANK_AGENT_NAME` + `UNION_BANK_NAME` |
| `backend/agent/batch.py` | **MODIFY** — `agent_type` param, store in DB, dispatch routing |
| `backend/agent/calls.py` | **MODIFY** — add 3 fields to form-data response |
| `frontend/agent-dashboard.html` | **MODIFY** — agent type dropdown |
| `frontend/app/bank/batch/page.tsx` | **MODIFY** — agent type dropdown |
| `frontend/app/` (form page) | **MODIFY** — conditional field visibility |
| DB migration | **NEW** — 2 ALTER TABLE statements |
