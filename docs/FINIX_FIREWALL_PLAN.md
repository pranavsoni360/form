# Firewall plan — 164.52.217.236

Written 2026-08-24 from a live survey of the box. **Nothing has been applied.**
This is the "where to put the wall so nothing breaks" answer.

---

## 1. The one thing that makes this safe

**Finix calling is outbound-only.** In 30 days of `livekit-sip` logs, the number
of inbound calls that matched a trunk or dispatch rule is **zero**. Every dial
starts with *us* sending an INVITE to `f06215d3.sip.vobiz.ai`
(`13.203.7.132`, `65.2.100.211` — AWS ap-south-1).

`nf_conntrack` is loaded. So a stateful rule —

```
-A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
```

— lets **every reply to an outbound call back in**: SIP responses on 5060, RTP
audio on 30000–31000, LiveKit RTC on 50000–50200, and every outbound API call
(Deepgram, Gemini, Groq, Sarvam, AiSensy, Vobiz, VG Docverify). None of them
need an inbound "allow new connections" rule.

**Consequence: we can drop all unsolicited inbound SIP and calling still works
exactly as it does today.** That is the whole toll-fraud surface closed with no
functional change.

---

## 2. Why this is urgent, not hygiene

Every single inbound SIP attempt in the last 72 hours was a **toll-fraud
attack**. From the logs:

| Attacker | Attempts | What they tried |
|---|---|---|
| `45.143.198.70` | 297 | `fromUser: trunk1 / 1001 / trunk_1` → `toUser: 0018258905020` |
| `194.213.3.117` | 15 | same pattern |
| `51.75.106.116` | — | spoofed `fromHost: 164.52.217.236` (pretending to be us) → `toUser: +972597580097` |
| ~12 others | 1 each | scanning |

`trunk1` / `1001` are the standard SIP trunk brute-force usernames. The
destinations are international premium-rate numbers — the goal is to make our
SIP server place expensive calls **billed to our Vobiz account**.

They are currently being stopped by **one thing**: LiveKit's own flood limiter
(`status: 486, reason: "flood"`). There is no firewall, no source restriction,
and no fail2ban behind it. If that limiter is misconfigured, out-scaled, or
regresses in a LiveKit upgrade, the next bill tells us.

---

## 3. Port-by-port decision

Surveyed every listening socket and mapped it to its process. Most docker
containers are **already** bound to `127.0.0.1` (mongodb, n8n, glitchtip,
pgadmin, the LOS postgres, llmthing, emailthing) — those need no rule at all.

### 3.1 Keep open to the internet — 5 ports

| Port | Owner | Why |
|---|---|---|
| **22** | sshd | our only way in. See §5 on the allowlist question |
| **80** | nginx | certbot HTTP-01 renewal + redirect to 443 |
| **443** | nginx | `virtualvaani.vgipl.com` — customers, banks, ops |
| **8443, 8444** | nginx | prod alternate vhosts |
| **8445** | nginx | QA (`finix.vgipl.com:8445`) |

### 3.2 Restrict to specific sources — 3 ports

| Port | Owner | Restrict to |
|---|---|---|
| **8446** | nginx → pgweb | the QA DB console. Office IPs only, or close it and use the `qa_tunnel` SSH tunnel that already exists. Basic-auth is the only control on it today |
| **1167** | `r1soft/bin/cdp` — **backup agent** | the R1Soft/CDP backup server's IP. **I do not have that IP** — get it from whoever runs the backups before applying, or this breaks backups |
| **10050** | `zabbix_agentd` | the Zabbix server's IP. Same caveat |

### 3.3 Drop inbound entirely — nothing legitimate connects from outside

| Port(s) | Owner | Why it is safe to drop |
|---|---|---|
| **5060, 5062** | `livekit-sip` (Finix, Vaani) | outbound-only; conntrack covers the replies. **This is the toll-fraud fix** |
| **30000–31000/udp** | SIP RTP | media for outbound calls arrives on an established flow |
| **7880, 7881** | `livekit-server` (Finix) | measured **0** established connections from anything but loopback. The agent dials `ws://127.0.0.1:7880` |
| **7890, 7891** | `livekit-server` (Vaani) | same |
| **50000–50200/udp** | LiveKit RTC | the only WebRTC participant is the on-box agent |
| **9090, 9091** | `egress` | Prometheus metrics — should never have been public |
| **8081, 8082, 8083** | prod agent health servers | the workers dial *out*; the only inbound traffic was scanners. Code fix already merged (`AGENT_HTTP_HOST`), applies on the next prod deploy. QA (8084–8086) is already loopback |
| **3001, 3002** | `node https-server.js` (prod + QA frontends) | nginx proxies to these. Direct exposure bypasses nginx entirely — including the `/api/internal/*` blocks. Worth binding to loopback in `https-server.js` as well |
| **8200, 8300** | uvicorn backends | already `127.0.0.1` only ✅ |
| **5000, 5173, 5434, 5680, 5678, 5681, 5682, 8011, 8012, 8090, 27017, 5432** | other stacks on this box (rootless docker, n8n, mongo, host postgres, glitchtip) | **not Finix.** Most are already loopback. The `0.0.0.0` ones (5000, 5173) belong to another user's rootless docker — confirm with its owner rather than assuming |

---

## 4. The rules

```bash
#!/usr/bin/env bash
# /root/finix-firewall.sh — review, then run via the §6 procedure. NOT applied yet.
set -euo pipefail

# --- fill these in before running -------------------------------------------
OFFICE_IPS=""          # e.g. "203.0.113.10 203.0.113.11" — for 8446
BACKUP_SERVER_IP=""    # for 1167 (r1soft). EMPTY = rule skipped, port stays open
ZABBIX_SERVER_IP=""    # for 10050.        EMPTY = rule skipped, port stays open
# ---------------------------------------------------------------------------

ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw default allow routed      # do NOT break docker's FORWARD path

# never lock ourselves out
ufw allow 22/tcp comment 'ssh'

# public web
ufw allow 80/tcp   comment 'nginx http (certbot)'
ufw allow 443/tcp  comment 'nginx https'
ufw allow 8443/tcp comment 'nginx prod alt'
ufw allow 8444/tcp comment 'nginx prod alt'
ufw allow 8445/tcp comment 'nginx QA'

# QA DB console — office only, else leave it closed
for ip in $OFFICE_IPS; do ufw allow from "$ip" to any port 8446 proto tcp comment 'qa db console'; done

# infrastructure agents — only from their servers
[ -n "$BACKUP_SERVER_IP" ] && ufw allow from "$BACKUP_SERVER_IP" to any port 1167 proto tcp comment 'r1soft backup'
[ -n "$ZABBIX_SERVER_IP" ] && ufw allow from "$ZABBIX_SERVER_IP" to any port 10050 proto tcp comment 'zabbix'

# Deliberately NO rules for SIP (5060/5062), RTP (30000-31000), LiveKit
# (7880/7881/7890/7891, 50000-50200), egress metrics (9090/9091) or the agent
# health ports (8081-8086). ufw's default rules already accept
# ESTABLISHED/RELATED, so every outbound call and its return media keep working.
# Adding an inbound rule here is what re-opens toll fraud.

ufw --force enable
ufw status verbose
```

### If inbound calls to our DIDs are ever needed

Only then, and only from the provider:

```bash
ufw allow from 13.203.7.132 to any port 5060 proto udp comment 'vobiz sip'
ufw allow from 65.2.100.211 to any port 5060 proto udp comment 'vobiz sip'
ufw allow from 13.203.7.132 to any port 5060 proto tcp comment 'vobiz sip'
ufw allow from 65.2.100.211 to any port 5060 proto tcp comment 'vobiz sip'
```

Those two A records can change — a Vobiz IP change would silently stop inbound
calls. Ask them for a stable range before relying on it.

---

## 5. Two things to decide first

**SSH allowlist.** The last 15 logins came from `47.11.15.106`, `47.11.19.207`,
`47.11.2.246`, `47.11.12.122` (Airtel dynamic — these rotate) and
`103.252.168.197`. Locking 22 to those IPs **will** lock you out the next time
the ISP reassigns. Options: leave 22 open (rate-limited via `ufw limit 22/tcp`),
or allowlist a stable office/VPN IP if one exists. My recommendation: leave it
open with `ufw limit`, and add fail2ban separately.

**The docker/ufw trap.** ufw does *not* filter ports published by docker with
`-p 0.0.0.0:...`, because docker inserts its rules in the `DOCKER` chain ahead
of ufw's `INPUT` filtering. Here that is not a problem — the LiveKit containers
use `network_mode: host`, so their ports go through `INPUT` and ufw *does*
control them, and every `-p` published container is already on `127.0.0.1`. But
if anyone later publishes a container on `0.0.0.0`, ufw will not protect it. Note
this in the runbook.

---

## 6. Rollout with automatic recovery

Never enable a firewall on this box without a dead-man's switch.

```bash
# 1. arm the revert FIRST — if we lock ourselves out, it recovers in 10 minutes
echo 'ufw --force disable' | at now + 10 minutes
atq                                  # note the job number

# 2. apply
bash /root/finix-firewall.sh

# 3. verify from a DIFFERENT machine, within the 10 minutes:
#      - ssh still works
#      - https://virtualvaani.vgipl.com loads
#      - https://finix.vgipl.com:8445 loads
#      - place ONE test call from the QA batch screen and confirm audio both ways
#      - /ops/live shows the call
#      - check `docker logs livekit-sip --since 5m` for the outbound INVITE

# 4. happy: cancel the revert
atrm <job-number>

# 5. unhappy: do nothing. It reverts itself.
```

Then watch for 24h: `ufw status numbered`, `journalctl -k | grep -i 'UFW BLOCK'`
for anything legitimate being dropped, and confirm a real batch runs.

---

## 7. What this does and does not fix

Fixes:
* Toll-fraud attempts on 5060/5062 stop reaching the SIP service at all
* LiveKit APIs, egress metrics and agent health ports become unreachable from
  the internet
* The QA DB console and both infrastructure agents get a source restriction

Does **not** fix (separate items):
* `/uploads` and `/api/recordings` are unauthenticated — you have decided to
  leave these open for now. They stay reachable through nginx on 443 regardless
  of any firewall, so the firewall does not change that exposure at all
* No rate limiting on the API (Aadhaar/PAN verify, exports) — application-level,
  see the audit doc §5.3
* No fail2ban on SSH
