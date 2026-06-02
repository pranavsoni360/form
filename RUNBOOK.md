# LOS — Local Development Runbook

## 1. Start Services (every session)

Open **3 separate terminals** from the project root in this order:

### Terminal 1 — Backend
```
cd backend
venv\Scripts\uvicorn.exe main:app --host 0.0.0.0 --port 8200
```

### Terminal 2 — Frontend
```
cd frontend
node_modules\.bin\next start -p 3001
```
> First time or after code changes: run `node_modules\.bin\next build` before `next start`

### Terminal 3 — Agent Worker
```
cd agent
venv\Scripts\python.exe los_updated.py dev
```

### Verify everything is up
```
curl http://localhost:8200/healthz     # → {"status":"ok"}
curl http://localhost:8200/readyz      # → alive=4/4
```

---

## 2. Login Credentials

| Portal | URL | Username | Password |
|---|---|---|---|
| Admin / Ops | http://localhost:3001/admin/login | `admin@bank.com` | `admin123` |
| Bank Officer | http://localhost:3001/bank/login | `ramesh.patil` | `bank123` |
| Bank Supervisor | http://localhost:3001/bank/login | `sunita.desai` | `bank123` |
| Vendor | http://localhost:3001/vendor/login | `bfl_e2e` | `vendor123pass` |

---

## 3. Complete Loan Flow

### Step 1 — Upload CSV (Bank Officer)
- Login to bank portal → **http://localhost:3001/bank/batch**
- Select: Language = Hindi, Voice = Male (Rajesh), Agent = Loan enquiry — Pusad
- CSV format (minimum required columns):
  ```
  name,phone
  Girish Nasare,8459948956
  ```
- Click **Upload Excel / CSV** → then **Start Batch**
- Dispatcher runs every 5 minutes (10 AM – midnight IST) → places SIP call

> **Always upload from `/bank/batch`, not `/ops/batch`** — bank portal auto-assigns `bank_id` so applications appear in the officer's list.

### Step 2 — Voice Call (Customer)
- Customer's phone rings
- Agent speaks in Hindi, collects: employer, designation, experience, loan purpose, loan amount
- Customer says interested → agent calls `send_form_link` → WhatsApp message sent

### Step 3 — Fill Form (Customer)
- Open WhatsApp link → enter phone number → receive OTP on WhatsApp
- Form auto-fills from call data (name, employer, designation, experience, loan amount)
- Verify PAN (real API via office network `10.200.10.43`)
- Verify Aadhaar via DigiLocker (requires office network for VG API)
- Fill remaining fields across 6 steps → Submit

### Step 4 — Officer Review (Bank Officer)
- Login: `ramesh.patil` / `bank123`
- Go to **Applications** → find the submitted application
- Review all details → click **Approve**
- Status changes: `submitted` → `officer_approved`

### Step 5 — Supervisor Approval (Bank Supervisor)
- Login (separate tab/window): `sunita.desai` / `bank123`
- Go to **Applications** → same application
- Click **Final Approve**
- Status changes: `officer_approved` → `approved`

### Step 6 — Vendor Assignment (Bank Officer/Supervisor)
- On the approved application → **Assign Vendor** panel
- Select vendor (e.g. Bajaj Finance E2E) → Assign
- Status changes: `approved` → `vendor_assigned`

### Step 7 — Disburse (Vendor)
- Login: `bfl_e2e` / `vendor123pass` → **http://localhost:3001/vendor/login**
- Go to **Dashboard** → find the assigned application
- Click **Accept** → then enter disbursement amount + reference number → **Disburse**
- Settlement auto-created with commission snapshot

---

## 4. Key Configuration Files

| File | Purpose |
|---|---|
| `backend/.env` | Backend config — DB, LiveKit, API keys, dispatcher hours |
| `frontend/.env.local` | Frontend config — API URL |
| `agent/.env.local` | Agent config — LiveKit, Deepgram, Gemini, Groq, Sarvam keys |

### Important env values
```
# backend/.env
SIP_TRUNK_ID=ST_AGGNogZb8jWD          # LiveKit SIP trunk
AGENT_NAME=pusad-bank-loan-enquiry-local   # must match agent/.env.local
DISPATCHER_STARTING_HOUR=10            # calls start at 10 AM IST
DISPATCHER_ENDING_HOUR=24              # calls until midnight IST
FORM_BASE_URL=http://localhost:3001    # form link sent in WhatsApp
VG_KEY=CONV27032026                    # VG DocVerify key for PAN/Aadhaar

# agent/.env.local
AGENT_NAME=pusad-bank-loan-enquiry-local   # must match backend/.env
BACKEND_URL=http://127.0.0.1:8200
```

---

## 5. Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| Call shows "Failed — No SIP trunk" | `SIP_TRUNK_ID` missing/wrong in `.env` | Update `SIP_TRUNK_ID` and restart backend |
| Call rings but silence | Agent worker not running | Start `agent/venv\Scripts\python.exe los_updated.py dev` |
| Application not visible in bank portal | `bank_id` is NULL (uploaded from ops/admin) | Upload from `/bank/batch` OR run: `UPDATE loan_applications SET bank_id='853d68da-6535-4370-9f41-0c6e35604795' WHERE bank_id IS NULL` |
| Bank login "Invalid credentials" | Wrong field — login uses **username** not email | Use `ramesh.patil` not `officer@pusadbank.com` |
| Bank login lockout | Too many failed attempts | `DELETE FROM login_attempts WHERE username='ramesh.patil'` |
| DigiLocker "Verification Key Doesnt Matched" | `VG_KEY` empty | Set `VG_KEY=CONV27032026` in `backend/.env` |
| DigiLocker Unicode error | Windows encoding bug | Fixed in code — restart backend |
| Frontend blank / BUILD_ID missing | Build was interrupted | Run `node_modules\.bin\next build` again |
| Form not pre-filled | Application has NULL `bank_id` or no session | Check `loan_sessions` table links to correct `loan_applications` row |
| Dispatcher not running | Outside calling hours or backend not started | Check `DISPATCHER_STARTING_HOUR` / `DISPATCHER_ENDING_HOUR` in `.env` |

---

## 6. Database Quick Checks

```sql
-- Recent calls
SELECT phone, status, form_sent, error_message, created_at
FROM agent_calls ORDER BY created_at DESC LIMIT 10;

-- Recent applications
SELECT loan_id, phone, status, bank_id, created_at
FROM loan_applications ORDER BY created_at DESC LIMIT 10;

-- Active loan sessions (OTP verified)
SELECT phone, otp_verified, created_at FROM loan_sessions ORDER BY created_at DESC LIMIT 5;

-- Clear bank login lockout
DELETE FROM login_attempts WHERE username = 'ramesh.patil';

-- Fix missing bank_id on applications
UPDATE loan_applications SET bank_id = '853d68da-6535-4370-9f41-0c6e35604795' WHERE bank_id IS NULL;
UPDATE agent_calls SET bank_id = '853d68da-6535-4370-9f41-0c6e35604795' WHERE bank_id IS NULL;
```

---

## 7. Infrastructure

| Component | Address | Notes |
|---|---|---|
| PostgreSQL | localhost:5432 | Native install, user: `los_admin`, pass: `los_dev_pass`, db: `los_form` |
| Backend API | http://localhost:8200 | FastAPI + uvicorn, 4 job workers, APScheduler |
| Frontend | http://localhost:3001 | Next.js 14 production build |
| Agent Worker | (local process) | Registers as `pusad-bank-loan-enquiry-local` on LiveKit |
| LiveKit Server | ws://164.52.217.236:7880 | Self-hosted on GPU box |
| VG DocVerify API | http://10.200.10.43 | Internal office network only |
