# QA Functional Flow Document — Vaani LOS (Digital Lending System)

**Audience:** QA team · **Purpose:** functional test reference for the initial QA cycle
**Scope of this cycle:** Login flow · functional flows for all roles · session handling · Conversation Agent · WhatsApp integration. **Out of scope:** LOS/LMS core integrations.

---

## 1. Environments & access

| | URL | Notes |
|---|---|---|
| **QA** | `https://<qa-host>` *(to be confirmed)* | isolated DB + test data; use this for all QA |
| Production | `https://finix.vgipl.com` | do NOT test here |

> The QA base URL + credentials are provided separately with the QA environment. All paths below are relative to the QA base URL.

### Portals (entry points)
| Portal | Login page | Audience |
|---|---|---|
| Customer loan form | `/loan-form` (opened via WhatsApp link / token) | applicants |
| Bank portal | `/bank/login` | Officer, Supervisor |
| Admin portal | `/admin/login` | Super-admin |
| Ops console | `/ops` | internal operators |
| Vendor portal | `/vendor/login` | NBFC partners (optional this cycle) |

### Test credentials (provisioned with QA env)
| Role | Username / Email | Password |
|---|---|---|
| Admin | `qa_admin` *(or admin email)* | *provided with env* |
| Bank **Officer** | `qa_officer` | `Officer@123` |
| Bank **Supervisor** | `qa_supervisor` | `Supervisor@123` |

---

## 2. Login flow validation

**Bank login** (`/bank/login`) and **Admin login** (`/admin/login`):

| # | Test | Steps | Expected result |
|---|---|---|---|
| L1 | Valid login | Enter correct username + password → Submit | Redirect to role dashboard; JWT stored; role-appropriate menu shown |
| L2 | Wrong password | Correct username, wrong password | Error "Invalid credentials"; no token issued; stays on login |
| L3 | Unknown user | Non-existent username | Error "Invalid credentials" (no user-enumeration leak) |
| L4 | Empty fields | Submit blank | Client-side validation blocks; no request |
| L5 | Inactive user | Use a deactivated account | Login refused |
| L6 | Role isolation | Officer logs in | Sees Officer scope only (no Supervisor-only / Admin actions) |
| L7 | Direct-URL guard | While logged out, open `/bank/dashboard` directly | Redirected to login (no protected content) |
| L8 | Cross-portal guard | Bank user token used on `/admin` | Access denied |

**What to verify technically:** passwords are bcrypt-checked server-side; tokens are JWT in `localStorage`; failed logins never reveal whether the username exists.

---

## 3. Session handling & validation

| # | Test | Steps | Expected result |
|---|---|---|---|
| S1 | Persistence | Login → refresh the page | Still logged in (session restored from token) |
| S2 | Logout | Click Logout | Token cleared; redirected to login; back button can't reach protected pages |
| S3 | Expiry | Wait for token to expire (or tamper/expire it) | Next protected action forces re-login |
| S4 | Tampered token | Modify the stored token | Rejected; forced re-login |
| S5 | Customer OTP session | Open a form link, request OTP, verify | OTP-gated session; reload keeps the in-progress form (autosave) |
| S6 | Form token reuse | Reuse an already-submitted form link | Blocked / shows submitted state (token `is_used`) |
| S7 | Concurrent sessions | Login same user in two tabs | Both work; logout in one doesn't silently corrupt the other |

---

## 4. Functional flows by role

### 4.1 Customer — Loan application form
Entry: customer receives a **WhatsApp link** (or QA opens a generated token URL `/form/<token>` or `/loan-form`).

| # | Step | Expected |
|---|---|---|
| C1 | Open form link | Form loads with any pre-filled data (name/phone from the lead/call) |
| C2 | OTP | Request + enter OTP | OTP validated; form unlocked |
| C3 | Multi-step fill | Personal → employment → loan → (guarantor if applicable) → review | Each step validates inputs; **autosave** persists progress |
| C4 | Guarantor section | For Personal Loan **> ₹1 lakh** | Guarantor Name + Phone fields shown (Optional label); ≤ ₹1 lakh → not required |
| C5 | Submit | Final submit | Status → **submitted**; WhatsApp confirmation sent; success page |
| C6 | Field validation | Bad phone/PAN/amount | Inline validation errors; submit blocked |

### 4.2 Ops console (`/ops`)
| # | Flow | Steps | Expected |
|---|---|---|---|
| O1 | Upload batch | `/ops/batch` → upload CSV/Excel (Name, Mobile_number, Email, Customer_type, loan_type, loan_amount) | Batch created; rows inserted as `Pending`; auto-dials within calling hours |
| O2 | Phone selection | Choose a caller-ID (or Auto) | Calls dial FROM chosen number (Auto = least-loaded) |
| O3 | Live calls | `/ops/live` | Active/just-finished calls update in real time (SSE) |
| O4 | Calls list | `/ops/calls` | Status, lead quality, duration, transcript, recording per call |
| O5 | Call detail | Open a call | Transcript, collected fields, guarantor consent badge, **audio player** |
| O6 | Recordings | `/ops/recordings` | Calls with audio listed; expand → **plays** the recording |
| O7 | Funnel/Analytics | `/ops/funnel`, `/ops/analytics` | Counts/categories reflect call outcomes |
| O8 | Callbacks | `/ops/callbacks` | Scheduled callbacks listed; re-dial at the scheduled time |
| O9 | Phones/Workers | `/ops/phones`, `/ops/workers` | Pool health (active/cooldown), agent worker status |
| O10 | Errors | `/ops/errors` | System errors surfaced |
| O11 | Emergency stop | Toggle stop | All outbound dispatch halts |

### 4.3 Bank Officer (`/bank`)
| # | Flow | Expected |
|---|---|---|
| B1 | Dashboard | Officer sees their bank's applications + stats only |
| B2 | Application list/detail | `/bank/applications` → open one: all customer/employment/loan/guarantor + call info, document badges, recording |
| B3 | **Approve** (officer) | Status `submitted` → `officer_approved`; transition audited |
| B4 | **Reject** (officer) | Status → `officer_rejected` with note; audited |
| B5 | Scope | Officer cannot perform Supervisor-only final approval |

### 4.4 Bank Supervisor (`/bank`)
| # | Flow | Expected |
|---|---|---|
| V1 | Review officer-approved | Sees applications at `officer_approved` |
| V2 | **Final approve** | Status → `approved`; audited |
| V3 | **Final reject** | Status → `supervisor_rejected`; audited |
| V4 | Scope | Supervisor sees the full review chain for their bank |

### 4.5 Admin (`/admin`)
| # | Flow | Expected |
|---|---|---|
| A1 | Banks | `/admin/banks` create/view banks |
| A2 | Bank users | Create Officer/Supervisor users for a bank (auto-generated password returned once) |
| A3 | Applications | `/admin/applications` cross-bank visibility |
| A4 | Vendors | `/admin/vendors` manage NBFC partners |

### 4.6 Vendor / NBFC (`/vendor`) — *optional this cycle*
Login → dashboard → assigned applications → settlements. (Skip if vendor flow not in this cycle.)

---

## 5. Conversation Agent (voice) testing

The agent is an outbound AI voice call (Hindi/Marathi/English). To test, QA places a call to **a phone they control and will answer**.

**How to trigger:** Ops → upload a 1-row batch with the QA tester's number (language + gender + agent type), or use the batch-call flow.

| # | Test | Expected |
|---|---|---|
| AG1 | Call connects | Tester's phone rings; on answer the agent **greets within 1–2s** (intro + "recorded for quality" + "Am I speaking with X?") |
| AG2 | Language | Set language hi/en/mr | Agent speaks the selected language |
| AG3 | Identity confirm | Say "yes / speaking" | Agent proceeds to the pitch (no double-greeting) |
| AG4 | Eligibility gate | Agent asks: salaried? + individual/personal purpose? | Ineligible answer → polite end; eligible → continues |
| AG5 | Loan type | Ask Personal vs Consumer | Correct heads-up; Personal **> ₹1 lakh** → asks about guarantor |
| AG6 | Q&A | Age, employer, EMI, amount, purpose, WhatsApp number | One question at a time, natural acknowledgments |
| AG7 | Amount > 1 lakh | Request 2 lakh | Personal: asks for guarantor; Consumer: caps at 1 lakh |
| AG8 | Form link | On agreement | Agent says it's sending the form; **WhatsApp form link arrives** |
| AG9 | Callback | Ask to be called later | Agent schedules a callback (appears in `/ops/callbacks`) |
| AG10 | Not interested / busy / wrong number | Each path | Polite, correct `end_call` reason |
| AG11 | Silence | Stay silent ~25s | Agent checks in, then ends politely |
| AG12 | Post-call | After hang-up | Transcript + recording saved; call shows in `/ops/calls` with status + lead quality |

### 5.1 Guarantor consent call (sub-flow)
| # | Test | Expected |
|---|---|---|
| G1 | Trigger | Submit a form with a guarantor name+phone (Personal > 1 lakh) | A consent call is queued to the guarantor |
| G2 | Consent call | Guarantor answers | Agent confirms identity, explains "{borrower} named you as guarantor", asks consent |
| G3 | Yes/No | Answer yes or no | Consent recorded; shows in bank application detail + ops call detail (Yes/No/Pending) |
| G4 | No answer | Don't answer | Retries (up to 3, with backoff); after that shows "No answer" |

> **Telephony note for QA:** outbound calls require the SIP trunk to allow the destination. Indian numbers work on the Vobiz trunk; international/Twilio destinations need provider permissions. Use Indian test numbers unless told otherwise.

---

## 6. WhatsApp integration testing

WhatsApp messages are sent via **AiSensy** campaigns.

| # | Trigger | Message | Expected |
|---|---|---|---|
| W1 | OTP request on form | OTP template | Tester receives OTP on WhatsApp; entering it unlocks the form |
| W2 | Agent sends form link | Form-link campaign | Tester receives the application-form link; opening it loads the form |
| W3 | Form submitted | Submission-confirmation campaign | Tester receives a "submitted successfully" confirmation |
| W4 | Loan approved | `loan_approved_confirm` campaign | Confirmation message on approval |
| W5 | Disbursement initiated | `loan_disbursement_initiated` campaign | Message on disbursement event |

**Verify:** correct template, correct dynamic fields (name, loan id, amount), delivery to the right number, and graceful handling when WhatsApp send fails (must not block the form/flow).

---

## 7. QA scope checklist (this cycle)

- [x] Login flow validation — §2
- [x] Functional flow testing for all roles — §4 (Customer, Ops, Officer, Supervisor, Admin; Vendor optional)
- [x] Session handling and validation — §3
- [x] Conversation Agent — §5
- [x] WhatsApp integration — §6
- [ ] LOS / LMS core integration — **OUT OF SCOPE this cycle**

---

## 8. Test data & prerequisites

- QA env seeded with: 1 QA bank, the 3 QA users (admin, officer, supervisor), and a few sample leads/applications across statuses (`draft`, `submitted`, `officer_approved`).
- At least one **WhatsApp-reachable test phone** the QA tester controls (for OTP, form link, and live agent calls).
- Calling hours: outbound calls only dispatch within **10:00–24:00 IST**.
- Status lifecycle reference: `draft → submitted → system_reviewed → officer_approved/rejected → documents_submitted → approved/supervisor_rejected`.

---

## 9. Known behaviors QA should expect (not bugs)

- Outbound calls cool down a number 3–5 min after each call; rapid repeated calls to one pinned number may briefly show "No SIP trunk" — use **Auto** caller-ID.
- "Not Answered" with very short duration = the callee didn't pick up / carrier dropped — not an app error.
- Recordings appear only for calls that actually connected and ran.
- WhatsApp delivery depends on the AiSensy account + template approval status.

---

*Document maintained alongside the codebase in `docs/`. Pair with `docs/TECHNICAL_DOCUMENTATION.md` for architecture.*
