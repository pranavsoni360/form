# Local Testing Guide

Quick start for engineers running the LOS stack on their laptop.
Covers: setup, default credentials, adding users, getting OTPs, and common commands.

---

## 1. First-time setup

### Prerequisites
- **Docker** (Docker Desktop or Colima) — Postgres runs in a container
- **Python 3.10–3.13** — agent worker (avoids the OpenSSL 3.6.x TLS regression on 3.14)
- **Node 18+** — frontend
- **macOS / Linux** (script paths assume bash)

### Clone + boot
```bash
git clone <repo-url> los-form && cd los-form

# Postgres password is required only on first run (when the container is created).
# Pick anything; it's local-only. Remember to put it in your shell or .envrc.
export LOS_PG_PASSWORD='localdev'

./run.sh start
```

`./run.sh start` does the full boot:
- Ensures the `los-postgres-dev` Docker container is running on port **5435**
- Applies `database/schema_v3.sql` on first boot, then every `database/migration_*.sql` in sorted order
- Creates `backend/venv`, installs Python deps
- Creates `agent/venv` (only if `agent/.env.local` exists), installs deps
- Starts: `backend` (FastAPI :8200), `frontend` (Vite dev :5180), and `agent` (LiveKit worker, if env present)

Logs land in `logs/backend.log`, `logs/frontend.log`, `logs/agent.log`.

### URLs
- **Admin dashboard**: http://localhost:5180/admin/login
- **Bank/Vendor portal login**: http://localhost:5180/login
- **Customer loan form** (legacy v1, optional — see §6): not bundled in V3 yet
- **Backend OpenAPI docs**: http://localhost:8200/docs

### Stop / restart
```bash
./run.sh stop          # kills backend + frontend + agent (leaves Postgres running)
./run.sh start         # idempotent — reuses existing container
./run.sh logs          # tail all logs
```

---

## 2. Default admin credentials

Hard-coded in `database/schema_v3.sql`:

| Field | Value |
|---|---|
| Username | `admin` |
| Password | `Virtual%09` |
| Role | `admin` |
| Login URL | http://localhost:5180/admin/login |

> The `%` and `09` are literal characters, not URL-encoded. Don't type a `%20` or anything — paste exactly `Virtual%09`.

After login you land on the admin dashboard where you can create banks, vendors, and other users from the UI.

---

## 3. Change the admin password (or any user's password)

Passwords are stored as bcrypt hashes in `users.password_hash`. To change one:

```bash
# Generate a new bcrypt hash. Replace 'NewPassword123' with your choice.
NEW_HASH=$(./backend/venv/bin/python -c \
    "import bcrypt; print(bcrypt.hashpw(b'NewPassword123', bcrypt.gensalt()).decode())")

# Apply it
docker exec -i los-postgres-dev psql -U los_admin -d los_form <<SQL
UPDATE users
   SET password_hash = '$NEW_HASH'
 WHERE username = 'admin';
SQL
```

Verify:
```bash
docker exec los-postgres-dev psql -U los_admin -d los_form -c \
  "SELECT username, role, is_active FROM users WHERE username='admin';"
```

---

## 4. Add users directly to the DB

You'll mostly want to do this through the admin UI, but if you need raw access:

### 4a. Add an admin user
```bash
HASH=$(./backend/venv/bin/python -c \
    "import bcrypt; print(bcrypt.hashpw(b'TestAdmin@01', bcrypt.gensalt()).decode())")

docker exec -i los-postgres-dev psql -U los_admin -d los_form <<SQL
INSERT INTO users (username, password_hash, full_name, email, role)
VALUES ('admin2', '$HASH', 'Admin Two', 'admin2@test.local', 'admin');
SQL
```

### 4b. Add a bank + bank_user
A `bank_user` requires a `bank_id`, so create the bank first:
```bash
HASH=$(./backend/venv/bin/python -c \
    "import bcrypt; print(bcrypt.hashpw(b'BankPass@01', bcrypt.gensalt()).decode())")

docker exec -i los-postgres-dev psql -U los_admin -d los_form <<SQL
WITH new_bank AS (
    INSERT INTO banks (name, code, status)
    VALUES ('Demo Bank', 'demo_bank', 'active')
    RETURNING id
)
INSERT INTO users (username, password_hash, full_name, email, role, bank_id)
SELECT 'bankuser1', '$HASH', 'Bank User One', 'bank1@demo.bank', 'bank_user', id
  FROM new_bank;
SQL
```

Login URL: http://localhost:5180/login (select **Bank** tab) → `bankuser1` / `BankPass@01`.

### 4c. Add a vendor + vendor_user
Vendor sits under a bank. Replace `<bank_id>` with the UUID of an existing bank:
```bash
HASH=$(./backend/venv/bin/python -c \
    "import bcrypt; print(bcrypt.hashpw(b'VendorPass@01', bcrypt.gensalt()).decode())")

docker exec -i los-postgres-dev psql -U los_admin -d los_form <<SQL
WITH bnk AS (SELECT id FROM banks WHERE code = 'demo_bank' LIMIT 1),
     new_vendor AS (
        INSERT INTO vendors (bank_id, name, code, status)
        SELECT id, 'Demo Vendor', 'demo_vendor', 'active' FROM bnk
        RETURNING id, bank_id
     )
INSERT INTO users (username, password_hash, full_name, email, role, bank_id, vendor_id)
SELECT 'vendor1', '$HASH', 'Vendor One', 'vendor1@demo.vendor',
       'vendor_user', bank_id, id
  FROM new_vendor;
SQL
```

Login URL: http://localhost:5180/login (select **Vendor** tab) → `vendor1` / `VendorPass@01`.

### 4d. Quick reference: which fields are required per role

| role | username | password_hash | full_name | bank_id | vendor_id |
|---|---|---|---|---|---|
| admin | required | required | optional | **must be NULL** | **must be NULL** |
| bank_user | required | required | optional | required | **must be NULL** |
| vendor_user | required | required | optional | required | required |
| customer | required (phone) | optional | optional | NULL | NULL |

A CHECK constraint enforces these — the INSERT will fail if you mismatch.

### 4e. Add a customer for form-flow testing (without going through a voice call)

The customer-facing form's `/api/request-otp` only works if the phone already exists in either `loan_applications` or `form_tokens`. Without a real voice call, you need to seed one row manually. Two recipes:

**Minimal** — just enough so the OTP send/verify works. Form opens empty, customer fills everything from scratch:

```bash
docker exec -i los-postgres-dev psql -U los_admin -d los_form <<SQL
INSERT INTO loan_applications
       (customer_name, phone, loan_id, current_step, status, last_saved_at)
VALUES ('Test Customer', '+919999999999',
        'TEST-' || substr(md5(random()::text), 1, 8),
        1, 'draft', NOW());
SQL
```

Then have the tester open `http://localhost:5180/?phone=9999999999` (or the v1 form URL) and click **Send OTP**. Read the OTP from `logs/backend.log` (see §5b).

**Full simulation** — fakes a completed voice call so the form opens with prefilled fields + green "Voice Call" badges next to employer / income / loan amount, exactly like a real post-call experience:

```bash
docker exec -i los-postgres-dev psql -U los_admin -d los_form <<'SQL'
DO $$
DECLARE
    new_call_id UUID;
    new_app_id  UUID;
BEGIN
    INSERT INTO agent_calls
        (id, customer_name, phone, status, started_at, ended_at,
         interested, transcript, collected_data, category, call_duration)
    VALUES
        (gen_random_uuid(), 'Test Customer', '+919999999999',
         'Called - Interested', NOW() - INTERVAL '5 minutes', NOW(),
         TRUE, '[]'::jsonb,
         '{"employer_name":"Acme Corp","designation":"Engineer","monthly_income":"95000","loan_purpose":"Personal"}'::jsonb,
         'Uncategorized', 300)
    RETURNING id INTO new_call_id;

    INSERT INTO loan_applications
        (id, agent_call_id, customer_name, full_name, phone, loan_id,
         employer_name, designation, employment_type, industry_type,
         monthly_gross_income, purpose_of_loan, loan_amount_requested,
         customer_type, status, current_step, last_saved_at, field_sources)
    VALUES
        (gen_random_uuid(), new_call_id,
         'Test Customer', 'Test Customer', '+919999999999',
         'AGENT-DEMO-' || substr(md5(random()::text), 1, 8),
         'Acme Corp', 'Engineer', 'salaried', 'private_sector',
         95000.00, 'Personal', 250000.00,
         'new', 'draft', 1, NOW(),
         '{"employer_name":         {"source":"agent_call","original":"Acme Corp","modified":false},
           "designation":           {"source":"agent_call","original":"Engineer","modified":false},
           "employment_type":       {"source":"agent_call","original":"salaried","modified":false},
           "monthly_gross_income":  {"source":"agent_call","original":"95000","modified":false},
           "purpose_of_loan":       {"source":"agent_call","original":"Personal","modified":false},
           "loan_amount_requested": {"source":"agent_call","original":"250000","modified":false},
           "customer_name":         {"source":"agent_call","original":"Test Customer","modified":false}
         }'::jsonb)
    RETURNING id INTO new_app_id;

    UPDATE agent_calls SET application_id = new_app_id WHERE id = new_call_id;
END $$;
SQL
```

Change `+919999999999` to whichever number you want to test against. Re-running the script appends another agent_call + loan_application — to reset, see §6 *Resetting everything*.

---

## 5. Getting OTPs

The backend has two OTP-sending paths, both used by the customer-facing form:
- `POST /api/send-otp` — token-based (admin-generated form link)
- `POST /api/request-otp` — session-based (phone-only entry)

### 5a. Path A — WhatsApp (when `AISENSY_API_KEY` is configured)
If `backend/.env` has `AISENSY_API_KEY` set to a real value, the OTP is sent to the customer's WhatsApp via AiSensy.

> "OTP arrives on your phone via WhatsApp from the configured AiSensy campaign within a few seconds."

If you're testing with someone else's phone or the WhatsApp message hasn't arrived, fall through to Path B.

### 5b. Path B — Read OTP from backend log (no WhatsApp / AiSensy not configured)
Both OTP endpoints **always** print the generated code to the backend log, regardless of AiSensy:

```python
print(f"OTP for {phone}: {otp}")           # main.py line 2880 (token flow)
print(f"OTP for {phone}: {otp}")           # main.py line 3829 (session flow)
print(f"[AiSensy OTP] Not configured. OTP for {phone}: {otp}")  # if no AISENSY_API_KEY
```

So during local testing:

```bash
# Tail the backend log and grep — OTPs appear in real time
tail -f logs/backend.log | grep -i 'OTP for'

# Or grep the last few in one shot
tail -200 logs/backend.log | grep -i 'OTP for' | tail -5
```

Example output:
```
OTP for +917021954565: 481250
```

That 6-digit code is what you enter into the form's OTP field.

### 5c. Trigger an OTP from CLI (skips going through the form UI)

```bash
# Session flow — works for any phone that has a loan_application or form_token
curl -sk -X POST http://localhost:8200/api/request-otp \
    -H 'Content-Type: application/json' \
    -d '{"phone":"7021954565","customer_name":"Vansh Raja"}'

# Then read the code:
tail -10 logs/backend.log | grep 'OTP for' | tail -1
```

### 5d. Pre-create a customer for OTP testing
The session-flow `/api/request-otp` only works if there's already a `loan_applications` or `form_tokens` row for that phone. To create one for testing:

```bash
docker exec -i los-postgres-dev psql -U los_admin -d los_form <<SQL
INSERT INTO loan_applications
       (customer_name, phone, loan_id, current_step, status, last_saved_at)
VALUES ('Test Customer', '+919999999999',
        'TEST-' || substr(md5(random()::text), 1, 8),
        1, 'draft', NOW());
SQL
```

Then:
```bash
curl -sk -X POST http://localhost:8200/api/request-otp \
  -H 'Content-Type: application/json' \
  -d '{"phone":"9999999999","customer_name":"Test Customer"}'
tail -5 logs/backend.log | grep 'OTP for'
```

---

## 6. Useful one-liners

### Database
```bash
# Open a psql shell
docker exec -it los-postgres-dev psql -U los_admin -d los_form

# Show all tables
docker exec los-postgres-dev psql -U los_admin -d los_form -c '\dt'

# Inspect a table's columns
docker exec los-postgres-dev psql -U los_admin -d los_form -c '\d loan_applications'

# Wipe + reinit DB (DESTRUCTIVE — everything gone, recreates from schema_v3.sql)
./run.sh wipe
```

### Logs
```bash
tail -f logs/backend.log     # FastAPI requests, OTP prints, errors
tail -f logs/frontend.log    # Vite dev server (mostly compile messages)
tail -f logs/agent.log       # LiveKit worker, only relevant if you're testing voice calls

# Grep for a specific call by ID
grep '<call_id>' logs/*.log
```

### Resetting everything for a clean run
```bash
./run.sh stop
./run.sh wipe         # DROPs all tables, reapplies schema_v3.sql + migrations
./run.sh start        # default admin / Virtual%09 will be back
```

### Common gotchas
- **`LOS_PG_PASSWORD` not set** → you'll get a fatal error on first boot. `export` it (anything works for local).
- **Port 5435 busy** → stop other Postgres containers, or change `BACKEND_PORT` / DB port in `run.sh` if you must.
- **macOS Homebrew openssl@3 TLS bug on Python 3.14** → if your agent worker can't reach Sarvam/OpenAI, see `agent/openssl-tls12.cnf` and the `OPENSSL_CONF` export in `run.sh:start_agent`. Already handled if you launch via `./run.sh agent`.
- **Customer loan form** (`/loan-form` etc.) is not in V3 yet. The Vite SPA at `:5180` only serves admin and portal dashboards. The full customer form lives in `frontend-v1-archive/` (Next.js) and is only deployed in prod via a hybrid proxy. Locally, customer-flow testing is best done by hitting the API directly with curl as in §5c.

---

## 7. Quick verification you have a working stack

```bash
# 1. Backend is up
curl -s http://localhost:8200/docs -o /dev/null -w "backend %{http_code}\n"
# expect: backend 200

# 2. Default admin login works (returns a JWT)
curl -s -X POST http://localhost:8200/api/auth/admin-login \
    -H 'Content-Type: application/json' \
    -d '{"username":"admin","password":"Virtual%09"}'
# expect: {"token":"eyJ...", "user": {...}}

# 3. Frontend serves the SPA
curl -s http://localhost:5180/ -o /dev/null -w "frontend %{http_code}\n"
# expect: frontend 200

# 4. Open the admin dashboard in a browser
open http://localhost:5180/admin/login    # macOS
xdg-open http://localhost:5180/admin/login # Linux
```

If those four pass, you're set. Login as `admin` / `Virtual%09` and start creating banks/vendors via the UI.

---

## 8. When to reach for direct DB inserts vs. the UI

Prefer the admin UI for:
- Creating banks, vendors, bank/vendor users (it auto-generates a one-time password and shows it in the modal — much easier than computing bcrypt hashes by hand)

Prefer direct SQL for:
- Bulk-seeding test data (loan applications, customers, agent calls)
- Fixing a known-broken record (e.g., setting `is_active=false` on a stale user)
- Resetting a forgotten password without going through the UI's reset flow

The `users` table CHECK constraint will reject inserts that violate role/scope (e.g., `bank_user` with NULL `bank_id`). If your INSERT errors with `chk_user_scope`, that's the constraint catching a bad combination.
