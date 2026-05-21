#!/usr/bin/env bash
# scripts/gpu-error-tailer.sh
#
# Runs ON the GPU box (164.52.217.236) alongside the LiveKit + SIP + Egress
# + Redis docker containers. Tails docker logs from each LiveKit-family
# container, filters OUT noise (scanner traffic, debug-level chatter), and
# POSTs only REAL errors to LOS backend's /api/internal/errors webhook.
#
# Run as systemd service (see bottom of file for unit + journald wiring).
#
# Why this script, not just "docker logs":
#   1. LiveKit logs are 90% scanner traffic — we filter those out
#   2. We dedupe identical errors within 60s (no spam)
#   3. We translate Go-log shape → /ops/errors event shape with source tag
#   4. We watch container EVENTS too (OOM kills, restart loops)
#
# Required env (export before run, or use systemd EnvironmentFile):
#   LOS_BACKEND_URL          - e.g. http://backend.your-domain.in:8200
#   LOS_INTERNAL_HMAC_SECRET - SAME value as backend/.env on backend box

set -euo pipefail

: "${LOS_BACKEND_URL:?Set LOS_BACKEND_URL (e.g. http://164.52.217.236:8200)}"
: "${LOS_INTERNAL_HMAC_SECRET:?Set LOS_INTERNAL_HMAC_SECRET (same as backend)}"

URL="${LOS_BACKEND_URL%/}/api/internal/errors"
DEDUP_WINDOW=60          # seconds — drop identical messages within this window
DEDUP_FILE=$(mktemp)
trap "rm -f $DEDUP_FILE" EXIT

# ── helpers ──────────────────────────────────────────────────────────────

# Compute HMAC-SHA256 of stdin and print hex
hmac_hex() {
  openssl dgst -sha256 -hmac "$LOS_INTERNAL_HMAC_SECRET" -hex | awk '{print $2}'
}

# POST a single error event. Args: source, exc_type, message [, metadata_json]
post_error() {
  local source="$1" exc_type="$2" message="$3" metadata="${4:-null}"

  # Dedupe: hash source+exc_type+message → check last_ts in file
  local key
  key=$(echo -n "$source|$exc_type|$message" | md5sum | awk '{print $1}')
  local now=$(date +%s)
  local last_ts=$(grep "^$key " "$DEDUP_FILE" 2>/dev/null | awk '{print $2}')
  if [[ -n "$last_ts" ]] && (( now - last_ts < DEDUP_WINDOW )); then
    return  # within window — drop
  fi
  # Update dedup file
  grep -v "^$key " "$DEDUP_FILE" > "$DEDUP_FILE.tmp" 2>/dev/null || true
  echo "$key $now" >> "$DEDUP_FILE.tmp"
  mv "$DEDUP_FILE.tmp" "$DEDUP_FILE"

  # Build body (jq for safety — handles quoting, unicode, etc.)
  local body
  body=$(jq -nc \
    --arg src "$source" \
    --arg t "$exc_type" \
    --arg m "${message:0:500}" \
    --argjson meta "$metadata" \
    '{source:$src, exc_type:$t, message:$m, metadata:$meta}')

  local sig
  sig=$(echo -n "$body" | hmac_hex)

  curl -fsS -X POST "$URL" \
       --max-time 5 \
       -H "Content-Type: application/json" \
       -H "X-LOS-Signature: $sig" \
       -d "$body" >/dev/null 2>&1 || \
    echo "[warn] failed to POST $source/$exc_type" >&2
}

# ── 1. livekit-server log filter ─────────────────────────────────────────
# Match REAL errors, NOT scanner noise. Patterns based on logs you showed:
#   SKIP: "No SIP trunk matched" (DEBUG-level, scanner probes)
#   SKIP: "Server transaction destroyed" (routine cleanup)
#   KEEP: "error", "ERROR", "fatal", "FATAL", "panic"
#   KEEP: "auth failure" from MATCHED trunks (real customer issues)
tail_livekit_server() {
  docker logs livekit-server -f --tail 0 2>&1 | while IFS= read -r line; do
    # Skip the scanner noise you showed
    if echo "$line" | grep -qE '"No SIP trunk matched"|"Server transaction (destroyed|terminating)"'; then
      continue
    fi
    # Match errors only
    if echo "$line" | grep -qE '\bERROR\b|\bERR\b|\bFATAL\b|panic:|level":"error"'; then
      meta=$(jq -nc --arg raw "$line" '{raw: $raw}')
      post_error "livekit" "LiveKitServerError" "$(echo "$line" | head -c 400)" "$meta"
    fi
  done
}

# ── 2. livekit-sip log filter ────────────────────────────────────────────
# Same logic — skip flood rejections (those are PROTECTION, not errors).
tail_livekit_sip() {
  docker logs livekit-sip -f --tail 0 2>&1 | while IFS= read -r line; do
    if echo "$line" | grep -qE 'reason":\s*"flood"|Rejecting inbound flood|Server transaction (destroyed|terminating)'; then
      continue
    fi
    if echo "$line" | grep -qE '\bERROR\b|\bFATAL\b|panic:|level":"error"|"failed":\s*true'; then
      meta=$(jq -nc --arg raw "$line" '{raw: $raw}')
      post_error "sip" "LiveKitSIPError" "$(echo "$line" | head -c 400)" "$meta"
    fi
  done
}

# ── 3. livekit-egress log filter ─────────────────────────────────────────
tail_livekit_egress() {
  docker logs livekit-egress -f --tail 0 2>&1 | while IFS= read -r line; do
    if echo "$line" | grep -qE '\bERROR\b|\bFATAL\b|panic:|level":"error"|failed to'; then
      meta=$(jq -nc --arg raw "$line" '{raw: $raw}')
      post_error "livekit" "LiveKitEgressError" "$(echo "$line" | head -c 400)" "$meta"
    fi
  done
}

# ── 4. redis log filter ──────────────────────────────────────────────────
tail_redis() {
  docker logs livekit-redis -f --tail 0 2>&1 | while IFS= read -r line; do
    # Redis log format: PID:M DD MMM HH:MM:SS.SSS # message
    if echo "$line" | grep -qE '# .*([Ee]rror|MISCONF|Out of memory|fatal)'; then
      meta=$(jq -nc --arg raw "$line" '{raw: $raw}')
      post_error "docker" "RedisError" "$(echo "$line" | head -c 400)" "$meta"
    fi
  done
}

# ── 5. docker container EVENTS (OOM, die, restart) ───────────────────────
# Watches the entire docker daemon — catches container crashes regardless
# of whether they wrote anything to stdout before dying.
tail_docker_events() {
  docker events --format '{{json .}}' \
                --filter 'type=container' \
                --filter 'event=die' \
                --filter 'event=oom' \
                --filter 'event=kill' \
                --filter 'event=restart' 2>&1 | \
  while IFS= read -r evt; do
    container=$(echo "$evt" | jq -r '.Actor.Attributes.name // .id')
    ev_type=$(echo "$evt" | jq -r '.status')
    exit_code=$(echo "$evt" | jq -r '.Actor.Attributes.exitCode // "-"')
    image=$(echo "$evt" | jq -r '.Actor.Attributes.image // "?"')

    msg="container=$container event=$ev_type exit=$exit_code image=$image"
    meta=$(jq -nc --arg c "$container" --arg ev "$ev_type" --arg exit "$exit_code" --arg img "$image" \
                 '{container:$c, event:$ev, exit_code:$exit, image:$img}')
    post_error "docker" "ContainerEvent" "$msg" "$meta"
  done
}

# ── Run all tailers in parallel ──────────────────────────────────────────
echo "[gpu-error-tailer] starting. POSTing to $URL"
tail_livekit_server  &
tail_livekit_sip     &
tail_livekit_egress  &
tail_redis           &
tail_docker_events   &
wait
