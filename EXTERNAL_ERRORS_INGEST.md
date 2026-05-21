# 📡 External Errors → /ops/errors

Single pane of glass for **everything** that goes wrong in the LOS platform. Backend errors already flow in via the FastAPI global handler — this doc explains how to wire OFF-process sources (voice agent on GPU, LiveKit server, SIP trunk, docker events, Postgres logs) into the SAME dashboard.

**Endpoint**: `POST /api/internal/errors` (HMAC-signed) → publishes to `event_bus` topic `errors` → `/ops/errors` UI shows it within ~200 ms.

---

## 1. Server-side setup (one time, ~2 min)

### Generate a strong shared secret

```bash
# Generate a 256-bit hex secret
openssl rand -hex 32
# → 7a8b3c... (64 hex chars)
```

### Add to `backend/.env`

```bash
LOS_INTERNAL_HMAC_SECRET=<paste the secret here>
```

### Restart backend

```bash
# from repo root
pkill -f "uvicorn main:app"
backend/venv/Scripts/uvicorn.exe main:app --host 0.0.0.0 --port 8200 > logs/backend.log 2>&1 &
```

### Verify

```bash
# No signature → 401
curl -X POST http://localhost:8200/api/internal/errors -d '{}'
# {"detail":"invalid signature"}

# With signature → 200 (using the secret you just set)
BODY='{"source":"agent","exc_type":"TestError","message":"hello from curl"}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$LOS_INTERNAL_HMAC_SECRET" -hex | awk '{print $2}')
curl -X POST http://localhost:8200/api/internal/errors \
     -H "Content-Type: application/json" \
     -H "X-LOS-Signature: $SIG" \
     -d "$BODY"
# {"ok":true,"correlation_id":"...","ts":...}
```

Open `http://localhost:3001/ops/errors` — should see the test event with a purple **AGENT** badge.

If 401 → secret mismatch. If 503 → env var missing or backend not restarted.

---

## 2. Sample caller code

Each external source ships errors to the same endpoint. Pattern is identical: build JSON, compute HMAC, POST.

### A. LiveKit voice agent (Python — drop-in logging handler)

Put this in your agent codebase. Add the handler to your root logger; every `logger.error()` / `logger.exception()` call gets forwarded automatically.

```python
# agent/los_error_handler.py
import hashlib
import hmac
import json
import logging
import os
import threading
import urllib.request

class LOSWebhookHandler(logging.Handler):
    """Forwards ERROR + WARNING logs to LOS /api/internal/errors.
    Fire-and-forget (in a thread) so logging never blocks the agent loop."""

    def __init__(self, base_url: str, secret: str, source: str = "agent"):
        super().__init__(level=logging.WARNING)
        self.url = f"{base_url.rstrip('/')}/api/internal/errors"
        self.secret = secret.encode()
        self.source = source

    def emit(self, record: logging.LogRecord):
        try:
            body = {
                "source": self.source,
                "level": "warning" if record.levelno == logging.WARNING else "error",
                "exc_type": record.exc_info[0].__name__ if record.exc_info else record.levelname,
                "message": self.format(record),
                "correlation_id": getattr(record, "correlation_id", None),
                "trace": self.formatter.formatException(record.exc_info) if record.exc_info else None,
                "metadata": {
                    "logger": record.name,
                    "module": record.module,
                    "line": record.lineno,
                },
            }
            raw = json.dumps(body).encode()
            sig = hmac.new(self.secret, raw, hashlib.sha256).hexdigest()
            req = urllib.request.Request(
                self.url,
                data=raw,
                headers={"Content-Type": "application/json", "X-LOS-Signature": sig},
                method="POST",
            )
            # Background thread — never block. 3s timeout.
            threading.Thread(
                target=lambda: urllib.request.urlopen(req, timeout=3),
                daemon=True,
            ).start()
        except Exception:
            pass  # never raise from a log handler


# In your agent's main.py / entrypoint:
import logging
from los_error_handler import LOSWebhookHandler

logger = logging.getLogger()  # root
logger.addHandler(LOSWebhookHandler(
    base_url=os.getenv("LOS_BACKEND_URL", "http://backend:8200"),
    secret=os.getenv("LOS_INTERNAL_HMAC_SECRET"),
    source="agent",
))
```

**On the GPU box**, set:
```bash
LOS_BACKEND_URL=http://164.52.217.236:8200  # or wherever backend is reachable
LOS_INTERNAL_HMAC_SECRET=<same secret as backend>
```

### B. LiveKit Go server (bash log tailer)

LiveKit logs to stdout/journald. Tail + grep for errors → POST.

```bash
#!/usr/bin/env bash
# scripts/livekit-error-tail.sh
# Run via systemd as a long-lived service alongside livekit.
set -euo pipefail

LOS_URL="${LOS_BACKEND_URL:-http://localhost:8200}/api/internal/errors"
SECRET="${LOS_INTERNAL_HMAC_SECRET:?LOS_INTERNAL_HMAC_SECRET required}"

journalctl -u livekit-server -f --output=cat | while IFS= read -r line; do
  # Match LiveKit's error log shape (JSON or plain). Adjust to your log format.
  if echo "$line" | grep -qiE '"level":"error"|FATAL|ERROR'; then
    body=$(jq -nc --arg msg "$line" \
                  --arg src "livekit" \
                  --arg t   "ServerError" \
                  '{source:$src, exc_type:$t, message:$msg}')
    sig=$(echo -n "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
    curl -fsS -X POST "$LOS_URL" \
         -H "Content-Type: application/json" \
         -H "X-LOS-Signature: $sig" \
         -d "$body" >/dev/null || true
  fi
done
```

### C. SIP trunk (Viva PSTN)

Same pattern as B, tailing whatever log file Viva produces (asterisk logs, etc.). Replace `livekit` with `sip` in the body.

### D. Docker container events (OOM, restart, exit)

```bash
#!/usr/bin/env bash
# scripts/docker-event-watcher.sh
set -euo pipefail

LOS_URL="${LOS_BACKEND_URL:-http://localhost:8200}/api/internal/errors"
SECRET="${LOS_INTERNAL_HMAC_SECRET:?}"

docker events --format '{{json .}}' --filter 'event=die' --filter 'event=oom' --filter 'event=kill' | \
while IFS= read -r evt; do
  container=$(echo "$evt" | jq -r '.Actor.Attributes.name // .id')
  ev_type=$(echo "$evt"  | jq -r '.status')
  exit_code=$(echo "$evt" | jq -r '.Actor.Attributes.exitCode // "-"')
  body=$(jq -nc --arg src "docker" \
                --arg t   "ContainerEvent" \
                --arg msg "container=$container event=$ev_type exit=$exit_code" \
                --argjson meta "$(echo "$evt" | jq '{container: (.Actor.Attributes.name // .id), event: .status, exit_code: .Actor.Attributes.exitCode}')" \
                '{source:$src, exc_type:$t, message:$msg, metadata:$meta}')
  sig=$(echo -n "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
  curl -fsS -X POST "$LOS_URL" \
       -H "Content-Type: application/json" \
       -H "X-LOS-Signature: $sig" \
       -d "$body" >/dev/null || true
done
```

Run as systemd service on prod host.

### E. Postgres log tailer (slow queries, deadlocks, FATAL)

```bash
#!/usr/bin/env bash
# scripts/postgres-error-tail.sh
set -euo pipefail

LOS_URL="${LOS_BACKEND_URL:-http://localhost:8200}/api/internal/errors"
SECRET="${LOS_INTERNAL_HMAC_SECRET:?}"
PG_LOG="${PG_LOG:-/var/lib/postgresql/16/log/postgresql.log}"

tail -F "$PG_LOG" | while IFS= read -r line; do
  # Only forward ERROR / FATAL / deadlock / OOM lines.
  if echo "$line" | grep -qiE 'ERROR|FATAL|deadlock|out of memory|canceling statement'; then
    body=$(jq -nc --arg src "postgres" --arg t "PostgresLog" --arg msg "$line" \
                  '{source:$src, exc_type:$t, message:$msg}')
    sig=$(echo -n "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
    curl -fsS -X POST "$LOS_URL" \
         -H "Content-Type: application/json" \
         -H "X-LOS-Signature: $sig" \
         -d "$body" >/dev/null || true
  fi
done
```

### F. Frontend browser errors (window.onerror)

If you want browser-side JS errors to also flow into `/ops/errors`, add this to `frontend/app/layout.tsx` or a `<script>` near `<body>`:

```tsx
// frontend/components/shared/BrowserErrorBeacon.tsx
"use client";
import * as React from "react";

export function BrowserErrorBeacon() {
  React.useEffect(() => {
    // NOTE: this DOES NOT HMAC-sign — would expose the secret to the browser.
    // Instead, this hits a UN-AUTHED but rate-limited frontend-only endpoint
    // (TODO: build /api/internal/frontend-errors that doesn't need HMAC).
    // For now this is a STUB — wire later or rely on Sentry browser SDK.
    const onError = (e: ErrorEvent) => {
      console.error("browser_error", e.message, e.filename, e.lineno);
    };
    window.addEventListener("error", onError);
    return () => window.removeEventListener("error", onError);
  }, []);
  return null;
}
```

Frontend → backend webhook with HMAC isn't viable because the secret would leak into the JS bundle. For browser errors, either:
- Use Sentry browser SDK (already wired — just needs `NEXT_PUBLIC_SENTRY_DSN`)
- OR build a separate `/api/public/frontend-errors` endpoint with rate-limiting per IP

Skip for now.

---

## 3. Source filter colors on /ops/errors

The dashboard tags each event by source with a distinct badge color:

| Source | Color | Means |
|---|---|---|
| **BACKEND** | Blue | FastAPI exception (already wired) |
| **AGENT** | Purple | LiveKit voice agent (Python on GPU) |
| **LIVEKIT** | Orange | LiveKit Go server |
| **SIP** | Teal | Viva PSTN trunk |
| **DOCKER** | Indigo | Container died / OOM-killed / restarted |
| **POSTGRES** | Emerald | Postgres ERROR / FATAL / deadlock |
| **FRONTEND** | Pink | Browser-side JS error |

The source filter pills above the table only show sources that have at least one event in the current time window — keeps the UI compact when only backend is firing.

---

## 4. Production checklist

When deploying to the GPU box / production server:

- [ ] Same `LOS_INTERNAL_HMAC_SECRET` on backend AND every caller
- [ ] `LOS_BACKEND_URL` env var on each caller points to reachable backend (use internal IP/DNS, not localhost)
- [ ] Backend reachable from agent box on port 8200 — verify with `curl http://<backend>:8200/healthz` from agent box
- [ ] Each log-tailer script wrapped in `systemd` with `Restart=always` (don't run as bare bash — they need supervision)
- [ ] Rate-limit considerations: a chatty log source can DoS the dashboard. Future enhancement = backend-side rate limit per source/IP
- [ ] Secret rotation playbook: change env var on backend + all callers + restart all simultaneously (~2 min downtime is fine — no events lost, callers just fail to POST temporarily)

---

## 5. Architecture decision record (why HMAC, not OAuth/JWT)

| Option | Why we chose / rejected |
|---|---|
| **HMAC shared secret** | ✅ Chosen. Long-lived, no token refresh, easy bash one-liner, no extra DB round trip. Symmetric so single revocation = single env var change |
| OAuth client credentials | ❌ Token refresh adds 3 extra moving parts. Overkill for trusted-network webhooks |
| mTLS | ❌ Cert distribution to every caller is operational pain at our scale |
| Public endpoint + IP allow-list | ❌ Fragile in multi-cloud / dev laptops on hotspot |
| No auth (trust internal network) | ❌ One compromised container = unbounded error spam = dashboard DoS |

---

## 6. Future enhancements (not required now)

- Backend-side rate limiting per `source` (token bucket, e.g. 100 events/min)
- Aggregation of duplicate errors (same `exc_type + first 100 chars of message` within 5 min → single row with count)
- Severity escalation (5+ errors in 60s from same source → POST to Telegram via existing notifier)
- Long-term archive: spool events to Sentry free tier (5k/mo) for 14-day retention
- Cross-source correlation by `correlation_id` (already supported, just needs upstream sources to pass through)

---

**TL;DR**: backend ready, paste secret in `.env`, restart, wire each external source with the snippets above, watch `/ops/errors` light up.
