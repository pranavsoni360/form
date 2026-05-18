#!/usr/bin/env bash
set -euo pipefail

# ══════════════════════════════════════════════════════════════════════════════
# LOS Form — Backup Restore Drill
#
# Runs weekly (suggested Sunday 03:30 IST via cron — see DEPLOYMENT.md).
#
# A backup that's never restored is not a backup. This script:
#   1. Pulls the most-recent encrypted .dump.gpg from B2
#   2. Spins up an ephemeral Postgres 16 container
#   3. Decrypts + pg_restores into the ephemeral DB
#   4. Runs row counts on key tables to confirm data integrity
#   5. Posts result to Discord (success or failure)
#   6. Tears down the ephemeral container
#
# Usage:
#   sudo bash scripts/restore_test.sh           # full drill
#   sudo bash scripts/restore_test.sh --keep    # keep ephemeral container
#                                                 (useful for poking at restored data)
#
# Required env:
#   BACKUP_GPG_PASSPHRASE
#
# Optional env (with defaults):
#   RCLONE_REMOTE=b2:voice-ops-backups
#   TELEGRAM_BOT_TOKEN=    (alerts disabled if unset)
#   TELEGRAM_CHAT_ID=
#   RESTORE_TEST_PORT=5499      (host port for the ephemeral pg container)
# ══════════════════════════════════════════════════════════════════════════════

RCLONE_REMOTE="${RCLONE_REMOTE:-b2:voice-ops-backups}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"
RESTORE_TEST_PORT="${RESTORE_TEST_PORT:-5499}"

KEEP_CONTAINER=0
for arg in "$@"; do
    case "$arg" in
        --keep) KEEP_CONTAINER=1 ;;
        --help|-h) sed -n '4,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown arg: $arg" >&2; exit 2 ;;
    esac
done

log()  { printf "\033[0;32m[%s]\033[0m %s\n" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$*"; }
warn() { printf "\033[0;33m[%s] WARN:\033[0m %s\n" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$*" >&2; }
die()  {
    msg="$*"
    printf "\033[0;31m[%s] ERROR:\033[0m %s\n" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$msg" >&2
    notify "critical" "Restore drill failed" "$msg"
    cleanup
    exit 1
}

notify() {
    # $1=severity, $2=title, $3=body — Telegram sendMessage transport
    [[ -z "$TELEGRAM_BOT_TOKEN" || -z "$TELEGRAM_CHAT_ID" ]] && return 0
    local emoji
    case "$1" in
        critical) emoji='🚨' ;;
        warning)  emoji='⚠️' ;;
        *)        emoji='ℹ️' ;;
    esac
    local now_utc
    now_utc=$(date -u +"%Y-%m-%d %H:%M:%S UTC")
    local text="${emoji} <b>$2</b>

$3

<i>⏰ ${now_utc}</i>"
    curl -fsS --max-time 5 -G \
        --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
        --data-urlencode "text=${text}" \
        --data-urlencode "parse_mode=HTML" \
        --data-urlencode "disable_web_page_preview=true" \
        "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" >/dev/null || true
}

TMP_DIR="$(mktemp -d)"
EPHEMERAL_CONTAINER="los-restore-test-$$"

cleanup() {
    if [[ $KEEP_CONTAINER -eq 0 ]]; then
        docker rm -f "$EPHEMERAL_CONTAINER" >/dev/null 2>&1 || true
    else
        log "Keeping ephemeral container: $EPHEMERAL_CONTAINER on port $RESTORE_TEST_PORT"
    fi
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# ── Pre-flight ───────────────────────────────────────────────────────────────
log "Restore drill starting"
[[ -z "${BACKUP_GPG_PASSPHRASE:-}" ]] && die "BACKUP_GPG_PASSPHRASE env var is required"
command -v docker >/dev/null 2>&1 || die "docker not installed"
command -v rclone >/dev/null 2>&1 || die "rclone not installed"
command -v gpg    >/dev/null 2>&1 || die "gpg not installed"

# ── 1. Find latest backup on B2 ──────────────────────────────────────────────
log "Finding latest backup on $RCLONE_REMOTE"
LATEST=$(rclone lsf --files-only --max-depth 3 \
    --include 'los_form-*.dump.gpg' \
    "$RCLONE_REMOTE" 2>/dev/null \
    | sort -r | head -1) || die "rclone lsf failed"

[[ -z "$LATEST" ]] && die "No backups found on $RCLONE_REMOTE"
log "Latest: $LATEST"

# ── 2. Download + decrypt ────────────────────────────────────────────────────
ENC_LOCAL="${TMP_DIR}/$(basename "$LATEST")"
DUMP_LOCAL="${ENC_LOCAL%.gpg}"

log "Downloading..."
# rclone needs the full path; if LATEST is nested (yyyy/mm/file.gpg) it works
# as-is. If we got just a filename, prepend the remote.
case "$LATEST" in
    */*) rclone copy "${RCLONE_REMOTE}/${LATEST}" "$TMP_DIR/" || die "rclone copy failed" ;;
    *)   rclone copy "${RCLONE_REMOTE}/${LATEST}" "$TMP_DIR/" || die "rclone copy failed" ;;
esac
[[ -f "$ENC_LOCAL" ]] || die "Downloaded file missing: $ENC_LOCAL"

log "Decrypting..."
gpg --batch --yes --quiet --decrypt \
    --passphrase "$BACKUP_GPG_PASSPHRASE" \
    --output "$DUMP_LOCAL" \
    "$ENC_LOCAL" || die "gpg decryption failed (wrong passphrase?)"

DUMP_SIZE=$(stat -c '%s' "$DUMP_LOCAL" 2>/dev/null || stat -f '%z' "$DUMP_LOCAL" 2>/dev/null || echo 0)
log "Decrypted dump: $((DUMP_SIZE / 1024)) KB"

# ── 3. Spin up ephemeral container ──────────────────────────────────────────
log "Starting ephemeral Postgres 16 on port $RESTORE_TEST_PORT"
docker run -d --rm \
    --name "$EPHEMERAL_CONTAINER" \
    -e POSTGRES_USER=los_admin \
    -e POSTGRES_PASSWORD=restore_drill_pw \
    -e POSTGRES_DB=los_form \
    -p "${RESTORE_TEST_PORT}:5432" \
    postgres:16 >/dev/null || die "Failed to start ephemeral postgres"

# Wait for ready
log "Waiting for ephemeral pg to be ready..."
for i in $(seq 1 30); do
    if docker exec "$EPHEMERAL_CONTAINER" pg_isready -U los_admin >/dev/null 2>&1; then
        break
    fi
    sleep 1
done
docker exec "$EPHEMERAL_CONTAINER" pg_isready -U los_admin >/dev/null || die "Ephemeral pg never became ready"

# ── 4. Restore dump ──────────────────────────────────────────────────────────
log "Restoring dump into ephemeral DB..."
docker cp "$DUMP_LOCAL" "$EPHEMERAL_CONTAINER:/tmp/restore.dump"
# pg_restore exits non-zero on harmless warnings (extension already exists, etc).
# We allow non-zero here and verify success by checking row counts below.
docker exec "$EPHEMERAL_CONTAINER" \
    pg_restore -U los_admin -d los_form --no-owner --no-acl /tmp/restore.dump \
    >/dev/null 2>&1 || warn "pg_restore reported warnings (verifying via row counts)"

# ── 5. Row counts on key tables ──────────────────────────────────────────────
log "Verifying restored data..."
counts_sql="
SELECT
  'banks=' || (SELECT COUNT(*) FROM banks) ||
  ' apps=' || (SELECT COUNT(*) FROM loan_applications) ||
  ' calls=' || (SELECT COUNT(*) FROM agent_calls) ||
  ' batches=' || (SELECT COUNT(*) FROM agent_batches) ||
  ' bank_users=' || (SELECT COUNT(*) FROM bank_users) ||
  ' migrations=' || (SELECT COUNT(*) FROM _migrations);
"
RESULT=$(docker exec "$EPHEMERAL_CONTAINER" psql -U los_admin -d los_form -At -c "$counts_sql" 2>&1) \
    || die "Verification query failed: $RESULT"

log "Restored counts: $RESULT"

# Sanity check: _migrations should have rows (we backfill v2-v5 + apply v6-v10).
MIGS_COUNT=$(echo "$RESULT" | grep -oE 'migrations=[0-9]+' | grep -oE '[0-9]+')
if [[ -z "$MIGS_COUNT" || "$MIGS_COUNT" -lt 1 ]]; then
    die "Restored DB has 0 _migrations rows — backup looks corrupt"
fi

# ── 6. Cleanup + report ──────────────────────────────────────────────────────
log "Drill successful"
notify "info" "Restore drill OK" \
    "Latest: $LATEST | Size: $((DUMP_SIZE / 1024)) KB | $RESULT"
