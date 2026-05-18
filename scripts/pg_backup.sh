#!/usr/bin/env bash
set -euo pipefail

# ══════════════════════════════════════════════════════════════════════════════
# LOS Form — Postgres Backup
#
# Runs nightly (suggested 02:30 IST via cron — see DEPLOYMENT.md).
#
# What it does:
#   1. pg_dump -Fc (custom format) the los_form database from the running
#      Docker container — pure SQL roundtrip, no host pg_dump version mismatch
#   2. Encrypt with gpg --symmetric (passphrase from env)
#   3. Upload to Backblaze B2 via rclone (configurable remote)
#   4. Prune local backups older than BACKUP_RETENTION_DAYS
#   5. Discord alert on failure (success ping optional)
#
# Usage:
#   sudo bash scripts/pg_backup.sh           # full nightly backup
#   sudo bash scripts/pg_backup.sh --dry-run # build dump locally, skip upload
#   sudo bash scripts/pg_backup.sh --no-discord  # silence Discord alerts
#
# Required env:
#   BACKUP_GPG_PASSPHRASE   - symmetric encryption passphrase
#
# Optional env (with defaults):
#   LOS_PG_CONTAINER=vaani-los-postgres   (prod) or los-postgres-dev (dev)
#   LOS_PG_USER=los_admin
#   LOS_PG_DB=los_form
#   BACKUP_DIR=/var/backups/los
#   RCLONE_REMOTE=b2:voice-ops-backups
#   BACKUP_RETENTION_DAYS=14
#   DISCORD_WEBHOOK_URL=
# ══════════════════════════════════════════════════════════════════════════════

# ── Config (override via env) ────────────────────────────────────────────────
LOS_PG_CONTAINER="${LOS_PG_CONTAINER:-vaani-los-postgres}"
LOS_PG_USER="${LOS_PG_USER:-los_admin}"
LOS_PG_DB="${LOS_PG_DB:-los_form}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/los}"
RCLONE_REMOTE="${RCLONE_REMOTE:-b2:voice-ops-backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
DISCORD_WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-}"

# ── Flags ────────────────────────────────────────────────────────────────────
DRY_RUN=0
NO_DISCORD=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --no-discord) NO_DISCORD=1 ;;
        --help|-h)
            sed -n '4,33p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "Unknown arg: $arg" >&2; exit 2 ;;
    esac
done

# ── Utility ──────────────────────────────────────────────────────────────────
log()   { printf "\033[0;32m[%s]\033[0m %s\n" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$*"; }
warn()  { printf "\033[0;33m[%s] WARN:\033[0m %s\n" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$*" >&2; }
die()   {
    msg="$*"
    printf "\033[0;31m[%s] ERROR:\033[0m %s\n" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$msg" >&2
    notify_discord "critical" "Postgres backup failed" "$msg"
    exit 1
}

notify_discord() {
    # $1=severity ("info"|"warning"|"critical"), $2=title, $3=body
    [[ $NO_DISCORD -eq 1 ]] && return 0
    [[ -z "$DISCORD_WEBHOOK_URL" ]] && return 0
    local color
    case "$1" in
        critical) color=15158332 ;;
        warning)  color=15844367 ;;
        *)        color=3447003 ;;
    esac
    # Escape the body for JSON (limited to common cases — no embedded quotes
    # in titles/bodies expected from this script)
    local body_escaped
    body_escaped=$(printf '%s' "$3" | sed 's/"/\\"/g' | tr '\n' ' ')
    curl -fsS -X POST -H 'Content-Type: application/json' \
        --max-time 5 \
        -d "{\"embeds\":[{\"title\":\"$2\",\"description\":\"$body_escaped\",\"color\":$color}]}" \
        "$DISCORD_WEBHOOK_URL" >/dev/null || true
}

# ── Pre-flight ───────────────────────────────────────────────────────────────
START_TS=$(date +%s)
log "LOS Postgres backup starting (container=$LOS_PG_CONTAINER db=$LOS_PG_DB)"
log "Dry-run: $DRY_RUN | Retention: ${BACKUP_RETENTION_DAYS}d | Remote: $RCLONE_REMOTE"

[[ -z "${BACKUP_GPG_PASSPHRASE:-}" ]] && die "BACKUP_GPG_PASSPHRASE env var is required"

# Verify deps
command -v docker  >/dev/null 2>&1 || die "docker not installed"
command -v gpg     >/dev/null 2>&1 || die "gpg not installed (apt install gnupg)"
if [[ $DRY_RUN -eq 0 ]]; then
    command -v rclone  >/dev/null 2>&1 || die "rclone not installed (curl https://rclone.org/install.sh | bash)"
fi

# Verify container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${LOS_PG_CONTAINER}$"; then
    die "Postgres container '$LOS_PG_CONTAINER' is not running"
fi

mkdir -p "$BACKUP_DIR"

# ── 1. pg_dump ───────────────────────────────────────────────────────────────
STAMP="$(date -u +"%Y%m%d-%H%M%S")"
DUMP_FILE="${BACKUP_DIR}/los_form-${STAMP}.dump"
ENC_FILE="${DUMP_FILE}.gpg"

log "Dumping → $DUMP_FILE"
docker exec "$LOS_PG_CONTAINER" pg_dump -U "$LOS_PG_USER" -d "$LOS_PG_DB" -Fc \
    > "$DUMP_FILE" || die "pg_dump failed"

DUMP_SIZE=$(stat -c '%s' "$DUMP_FILE" 2>/dev/null || stat -f '%z' "$DUMP_FILE" 2>/dev/null || echo 0)
log "Dump complete: $((DUMP_SIZE / 1024)) KB"

[[ $DUMP_SIZE -lt 1024 ]] && die "Dump file is suspiciously small (<1KB) — refusing to upload"

# ── 2. Encrypt ───────────────────────────────────────────────────────────────
log "Encrypting → $ENC_FILE"
gpg --batch --yes --quiet --symmetric \
    --cipher-algo AES256 \
    --passphrase "$BACKUP_GPG_PASSPHRASE" \
    --output "$ENC_FILE" \
    "$DUMP_FILE" || die "gpg encryption failed"

rm -f "$DUMP_FILE"  # encrypted version is the source of truth from here on

ENC_SIZE=$(stat -c '%s' "$ENC_FILE" 2>/dev/null || stat -f '%z' "$ENC_FILE" 2>/dev/null || echo 0)
log "Encrypted size: $((ENC_SIZE / 1024)) KB"

# ── 3. Upload to B2 ──────────────────────────────────────────────────────────
if [[ $DRY_RUN -eq 1 ]]; then
    log "DRY RUN — skipping rclone upload. Encrypted backup at: $ENC_FILE"
else
    REMOTE_PATH="${RCLONE_REMOTE}/$(date -u +"%Y/%m")/$(basename "$ENC_FILE")"
    log "Uploading → $REMOTE_PATH"
    rclone copyto --max-duration 10m "$ENC_FILE" "$REMOTE_PATH" \
        || die "rclone upload failed"
    log "Upload OK"
fi

# ── 4. Prune local backups ───────────────────────────────────────────────────
log "Pruning local backups older than ${BACKUP_RETENTION_DAYS}d"
PRUNED=0
find "$BACKUP_DIR" -name "los_form-*.dump.gpg" -mtime +"$BACKUP_RETENTION_DAYS" -print -delete \
    | while read -r f; do PRUNED=$((PRUNED + 1)); done || true

# ── 5. Done ──────────────────────────────────────────────────────────────────
ELAPSED=$(( $(date +%s) - START_TS ))
log "Backup complete in ${ELAPSED}s"
if [[ $DRY_RUN -eq 0 ]]; then
    notify_discord "info" "Postgres backup OK" "Size: $((ENC_SIZE / 1024)) KB | Elapsed: ${ELAPSED}s | Remote: $REMOTE_PATH"
fi
