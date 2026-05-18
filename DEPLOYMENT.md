# LOS Form — Deployment Operations

Target environment: single GPU server (164.52.217.236, virtualvaani.vgipl.com), Docker, Linux.

Stack on host: Postgres 16 container, FastAPI backend (port 8200), Next.js frontend (port 3001), self-hosted LiveKit at the same IP.

This document is the operational runbook. Architecture lives in `HANDOFF.md`; this is how to **deploy, back up, restore, and tune for 500+ calls/day in production**.

---

## 1. First-Time Deployment

```bash
# On the GPU server, as root:
LOS_PG_PASSWORD='<strong password>' \
JWT_SECRET="$(openssl rand -hex 32)" \
ENCRYPTION_KEY="$(openssl rand -hex 32)" \
sudo bash scripts/deploy.sh
```

`deploy.sh` (existing) handles: clone repo, Docker postgres, Python venv, Next.js build, systemd services. See its `--help` for flags.

---

## 2. Environment variables (production)

Required, set in `/root/vaani_los_form/backend/.env`:

| Var | Purpose |
|---|---|
| `LOS_ENV` | `prod` — turns on the boot-time check that refuses to start with default JWT/encryption secrets |
| `DATABASE_URL` | `postgresql://los_admin:<pw>@localhost:5434/los_form` |
| `JWT_SECRET` | ≥32 char random string |
| `ENCRYPTION_KEY` | ≥32 char random string |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `SIP_TRUNK_ID` | LiveKit/SIP credentials |
| `GEMINI_API_KEY`, `DEEPGRAM_API_KEY`, `SARVAM_API_KEY` | AI providers |
| `AISENSY_API_KEY`, `AISENSY_CAMPAIGN_NAME` | WhatsApp form delivery |
| `RECORDING_BASE_URL` | Where LiveKit egress serves recordings (e.g. `http://164.52.217.236:7000`) |
| `SENTRY_DSN_BACKEND` | Sentry project DSN (free tier OK) |
| `DISCORD_WEBHOOK_URL` | Discord webhook for critical alerts |
| `BACKUP_GPG_PASSPHRASE` | Symmetric passphrase for nightly DB dump encryption |
| `DB_POOL_MIN`, `DB_POOL_MAX` | DB pool sizing (defaults 10/40). See §6 |
| `DISPATCHER_CONCURRENCY` | Concurrent in-flight calls (default 5). See §6 |

Full template: `backend/.env.example`.

---

## 3. Nightly Backups (M8-lite)

### 3.1 First-time setup

Install dependencies once on the server:

```bash
apt update && apt install -y gnupg curl
curl https://rclone.org/install.sh | sudo bash
```

Configure rclone with a Backblaze B2 remote named `b2`:

```bash
rclone config
# > n (new remote)
# > name: b2
# > type: 5 (Backblaze B2)
# > account: <B2 application key ID>
# > key: <B2 application key>
# > endpoint: (leave blank)
# > y (yes, this is OK)
# > q (quit config)

# Verify
rclone lsd b2:
```

Create the destination bucket `voice-ops-backups` in the B2 web console (or `rclone mkdir b2:voice-ops-backups`). B2 lifecycle rule: keep last 30 days of daily backups, plus 1 per month forever.

### 3.2 Schedule nightly dump

Add to root's crontab (`sudo crontab -e`):

```cron
# Nightly Postgres backup at 02:30 IST = 21:00 UTC
0 21 * * * BACKUP_GPG_PASSPHRASE='<passphrase>' DISCORD_WEBHOOK_URL='<webhook>' /root/vaani_los_form/scripts/pg_backup.sh >> /var/log/los/pg_backup.log 2>&1

# Weekly restore drill, Sundays at 03:30 IST = 22:00 UTC Saturday
0 22 * * 6 BACKUP_GPG_PASSPHRASE='<passphrase>' DISCORD_WEBHOOK_URL='<webhook>' /root/vaani_los_form/scripts/restore_test.sh >> /var/log/los/restore_test.log 2>&1
```

The passphrase MUST match between backup and restore scripts.

### 3.3 What the scripts do

- `scripts/pg_backup.sh`
  - `pg_dump -Fc` inside the running container (no host pg version mismatch)
  - Encrypts with `gpg --symmetric --cipher-algo AES256`
  - Uploads to `b2:voice-ops-backups/<yyyy>/<mm>/los_form-<UTC stamp>.dump.gpg`
  - Prunes local copies older than 14 days
  - Discord ping on success (info color) or failure (critical color)
  - Flags: `--dry-run` skips upload, `--no-discord` silences alerts

- `scripts/restore_test.sh`
  - Downloads the latest backup from B2
  - Spawns ephemeral `postgres:16` container on port 5499
  - Decrypts + `pg_restore`s
  - Runs row counts on `banks / loan_applications / agent_calls / agent_batches / bank_users / _migrations`
  - Discord ping with counts on success, with stack on failure
  - Auto-tears-down the container (use `--keep` to inspect manually)

### 3.4 Manual restore (disaster recovery)

```bash
# 1. Stop the running backend so it doesn't write during restore
systemctl stop los-backend

# 2. Find the backup you want
rclone ls b2:voice-ops-backups/2026/05/ | sort

# 3. Download + decrypt
cd /tmp
rclone copy b2:voice-ops-backups/2026/05/los_form-20260518-...dump.gpg .
gpg --decrypt --passphrase '<passphrase>' --output los_form.dump los_form-...dump.gpg

# 4. Wipe + restore (DESTRUCTIVE — be sure)
docker exec vaani-los-postgres dropdb -U los_admin los_form
docker exec vaani-los-postgres createdb -U los_admin los_form
docker cp los_form.dump vaani-los-postgres:/tmp/
docker exec vaani-los-postgres pg_restore -U los_admin -d los_form --no-owner --no-acl /tmp/los_form.dump

# 5. Restart backend
systemctl start los-backend
curl http://localhost:8200/readyz  # all components should report ok
```

---

## 4. Health checks

| Endpoint | What it means | Used by |
|---|---|---|
| `GET /healthz` | Process is alive enough to serve HTTP. Always 200. | Docker healthcheck, k8s liveness probe |
| `GET /readyz` | DB acquires OK, no circuit breakers open, job workers alive. 200 or 503. | Load balancer, k8s readiness probe |
| `GET /version` | `{"version", "env", "uptime_seconds"}` | Deploy verification |

Quick smoke check after deploy:

```bash
curl -s http://localhost:8200/readyz | jq .
# {
#   "status": "ok",
#   "checks": {"db": "ok", "circuits": "none_registered", "job_workers": "alive=4/4"},
#   "uptime_seconds": 18
# }
```

Anything other than 200 → don't route traffic; investigate.

---

## 5. Observability

### 5.1 Logs

Structured JSON, one record per line. Default: stdout (captured by uvicorn → journalctl).

```bash
# Tail with jq for human reading
journalctl -u los-backend -f -o cat | jq -r '. | "\(.["@timestamp"]) [\(.["log.level"])] \(.["service.name"]) \(.message)"'

# Filter by correlation ID (you got it from a frontend X-Correlation-Id header)
journalctl -u los-backend --since "1 hour ago" -o cat | jq 'select(.["trace.id"] == "<id>")'

# Errors only
journalctl -u los-backend -f -o cat | jq 'select(.["log.level"] == "error")'
```

### 5.2 Sentry

All unhandled exceptions auto-captured (M1 wiring). PII scrubber redacts PAN, Aadhaar, phone before payload leaves the host.

If `SENTRY_DSN_BACKEND` is unset, Sentry is disabled (the app boots fine).

### 5.3 Discord alerts

Trigger points (M1 + M5):
- Migration failure on startup
- Job worker pool failed to start
- Job exhausted retries (per `job_type`, rate-limited 1/5min)
- Dispatcher: no SIP trunk available
- Dispatcher: high failure rate (≥5 failures AND >50% in a batch)
- Circuit breaker transitioned OPEN (per breaker name)
- `pg_backup.sh` failure
- `restore_test.sh` weekly result (success or failure)

Rate-limited token bucket: 1 alert per 5-minute window per `dedupe_key`, plus a "still firing" summary every 30 minutes.

---

## 6. Tuning for 500+ calls/day

### 6.1 Application knobs (env vars)

| Var | Default | When to bump |
|---|---|---|
| `DISPATCHER_CONCURRENCY` | 5 | Bump to 10 if you add a second SIP trunk and want to dial faster |
| `DISPATCHER_MAX_CALLS_PER_RUN` | 50 | Bump if a single batch is huge and the 5-min cron tick can't drain it |
| `DB_POOL_MIN` / `DB_POOL_MAX` | 10 / 40 | Bump max if `/readyz` shows DB-timeout under load |

### 6.2 Postgres host config

For an 8 GB RAM Postgres host (single-purpose machine, no other heavy workloads):

```conf
# /etc/postgresql/16/main/postgresql.conf  (or via container env)
max_connections = 200
shared_buffers = 2GB
effective_cache_size = 6GB
work_mem = 16MB
maintenance_work_mem = 512MB
wal_compression = on
checkpoint_timeout = 15min
default_statistics_target = 100
shared_preload_libraries = 'pg_stat_statements'
```

Why these numbers:
- `max_connections=200` — fits two uvicorn workers × 40 conns each + room for psql admin sessions
- `shared_buffers=2GB` — ¼ of RAM is the standard rule
- `effective_cache_size=6GB` — what Postgres assumes the OS page cache will provide
- `work_mem=16MB` — large enough for the GIN-index JSONB lookups in M2
- `wal_compression=on` — cheap CPU for smaller WAL, helps backup size

After changing, restart the Postgres container.

### 6.3 Capacity math

500 calls/day spread over 8 working hours (10am–6pm IST) ≈ ~1 call/min average, ~3 calls/min peak.

With `DISPATCHER_CONCURRENCY=5` and average call duration 60s:
- Peak in-flight: 5 calls
- Throughput cap: 5 × (60/60) = 5 calls/min wall-clock
- Daily ceiling at this concurrency: ~2400/day theoretical, comfortable headroom for 500/day with 2× burst

DB pool math:
- ~6 roundtrips per call × 3 calls/sec peak init = ~18 QPS sustained
- 40 conns easily absorbs this

---

## 7. Common operational scenarios

### 7.1 Emergency stop all calling

```bash
curl -X POST http://localhost:8200/api/agent/emergency-stop
# Returns: {"status":"success","message":"Emergency stop activated — all batches paused","active_call_killed":true}
```

Restart: `POST /api/agent/resume-calling`.

### 7.2 A worker keeps crashing

Check Discord for `worker_crash` alerts (rate-limited, but you'll see at least one). Then:

```bash
journalctl -u los-backend --since "10 min ago" -o cat | jq 'select(.["log.level"] == "error")'
```

Restart the backend: `systemctl restart los-backend`. On startup, `cleanup_stuck_calls` resets any rows left at status='Calling' for >10 min.

### 7.3 Job queue is backing up

```sql
SELECT job_type, status, COUNT(*)
FROM call_processing_jobs
GROUP BY job_type, status
ORDER BY job_type, status;
```

If `pending > 100`, check that workers are alive: `curl /readyz` → expect `job_workers: alive=4/4`. If fewer, restart backend.

### 7.4 LiveKit started returning errors

The `livekit` and `livekit_sip` circuit breakers will trip OPEN after 5 consecutive failures. Discord fires once when each transitions to OPEN. The breaker auto-probes recovery after 30s — if LiveKit comes back, it self-heals to CLOSED.

If `/readyz` shows `circuits: open: livekit_sip`, the breaker thinks SIP is dead. Verify:
- LiveKit container status: `docker logs livekit-server --tail 100`
- SIP trunk valid: try a manual `lk dispatch create` from the host

### 7.5 Phone-pool seed (multi-trunk migration)

The dispatcher falls back to env `SIP_TRUNK_ID` when `phone_numbers` is empty. To migrate to multi-trunk:

```sql
-- 1. Confirm the PUSAD bank + default pool exist (M2 migration seeds these)
SELECT pp.id, pp.name, pp.capacity FROM phone_pools pp
JOIN banks b ON b.id = pp.bank_id WHERE b.code = 'PUSAD';

-- 2. Add the existing single trunk
INSERT INTO phone_numbers (pool_id, phone_number, livekit_trunk_id, status)
VALUES (
  (SELECT id FROM phone_pools WHERE name = 'pusad-default' LIMIT 1),
  '+912269738962',
  'ST_xxxxxxxxx',   -- the same trunk ID currently in SIP_TRUNK_ID env
  'active'
);

-- Now the dispatcher will read from phone_numbers (enforcing cooldown)
-- and you can add more trunks without redeploying.
```

---

## 8. Rollback

Each milestone landed on its own branch (M2/M3/M1/M4-lite/M5/M8-lite). To roll back any single one without losing the others, revert just that branch's merge commit:

```bash
git log --oneline main
# Find the merge commit for, e.g., feature/m4-lite-dispatcher
git revert -m 1 <merge-sha>
```

If a migration reveals a schema problem, `_migrations` rows can be deleted to force re-application after a code fix:

```sql
DELETE FROM _migrations WHERE filename = 'migration_v9_metrics_and_indexes.sql';
-- Restart backend → migration runner re-applies it
```

(Only do this if the migration is idempotent — all of v6–v10 are.)
