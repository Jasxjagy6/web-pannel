#!/usr/bin/env bash
#
# scripts/backup-now.sh — pre-deploy backup of the durable state.
#
# Snapshot:
#   1. Postgres   — pg_dump --format=custom into backups/<ts>/postgres.dump
#   2. Redis      — RDB save + copy into backups/<ts>/redis.rdb
#   3. Uploads    — tar gz of the uploads volume into backups/<ts>/uploads.tar.gz
#   4. Sessions   — tar gz of the sessions volume into backups/<ts>/sessions.tar.gz
#
# Retention: keep the most recent BACKUP_RETAIN (default 10) snapshots.
#
# This script is invoked automatically by `bin/upgrade deploy` unless
# `--skip-backup` is passed. Failures abort the deploy by default; set
# BACKUP_REQUIRED=false to make backup failures non-fatal.
#
# All operations go through the running docker compose stack; this script
# does not require psql / redis-cli on the host.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$REPO_ROOT/backups/$TS"
RETAIN="${BACKUP_RETAIN:-10}"

mkdir -p "$DEST"

log() { printf '[backup %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# Compose project is the directory name lowercased. We let docker pick up
# COMPOSE_PROJECT_NAME from the environment if the operator overrode it.
COMPOSE="${COMPOSE_BIN:-docker compose}"

###############################################################################
# 1. Postgres
###############################################################################
log "dumping postgres → $DEST/postgres.dump"
$COMPOSE exec -T postgres \
  pg_dump -U postgres -p 5435 -d telegram_panel --format=custom \
  > "$DEST/postgres.dump"
SIZE_PG=$(stat -c%s "$DEST/postgres.dump" 2>/dev/null || stat -f%z "$DEST/postgres.dump")
log "  postgres.dump ${SIZE_PG} bytes"

###############################################################################
# 2. Redis (BGSAVE then copy the rdb)
###############################################################################
log "saving redis snapshot → $DEST/redis.rdb"
PASS="${REDIS_PASSWORD:-Navneetbb1###}"
$COMPOSE exec -T redis redis-cli -p 6382 -a "$PASS" --no-auth-warning SAVE > /dev/null
$COMPOSE exec -T redis cat /data/dump.rdb > "$DEST/redis.rdb"
SIZE_REDIS=$(stat -c%s "$DEST/redis.rdb" 2>/dev/null || stat -f%z "$DEST/redis.rdb")
log "  redis.rdb ${SIZE_REDIS} bytes"

###############################################################################
# 3. Uploads volume (session files etc.)
###############################################################################
log "tarring uploads volume → $DEST/uploads.tar.gz"
docker run --rm \
  -v "web-pannel_uploads_data:/data:ro" \
  -v "$DEST:/out" \
  alpine:3 sh -c 'cd /data && tar czf /out/uploads.tar.gz . 2>/dev/null || true'
[ -f "$DEST/uploads.tar.gz" ] && \
  log "  uploads.tar.gz $(stat -c%s "$DEST/uploads.tar.gz" 2>/dev/null || stat -f%z "$DEST/uploads.tar.gz") bytes"

###############################################################################
# 4. Sessions volume
###############################################################################
log "tarring sessions volume → $DEST/sessions.tar.gz"
docker run --rm \
  -v "web-pannel_sessions_data:/data:ro" \
  -v "$DEST:/out" \
  alpine:3 sh -c 'cd /data && tar czf /out/sessions.tar.gz . 2>/dev/null || true'

###############################################################################
# 5. Manifest
###############################################################################
cat > "$DEST/manifest.json" <<EOF
{
  "ts":             "$TS",
  "git_sha":        "$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)",
  "git_ref":        "$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)",
  "files": {
    "postgres.dump":     $(stat -c%s "$DEST/postgres.dump"     2>/dev/null || stat -f%z "$DEST/postgres.dump"),
    "redis.rdb":         $(stat -c%s "$DEST/redis.rdb"         2>/dev/null || stat -f%z "$DEST/redis.rdb"),
    "uploads.tar.gz":    $(stat -c%s "$DEST/uploads.tar.gz"    2>/dev/null || stat -f%z "$DEST/uploads.tar.gz" || echo 0),
    "sessions.tar.gz":   $(stat -c%s "$DEST/sessions.tar.gz"   2>/dev/null || stat -f%z "$DEST/sessions.tar.gz" || echo 0)
  }
}
EOF

###############################################################################
# 6. Retention — drop the oldest snapshots beyond BACKUP_RETAIN
###############################################################################
cd "$REPO_ROOT/backups"
TO_DROP=$(ls -1dt */ 2>/dev/null | tail -n +"$((RETAIN + 1))" || true)
if [ -n "$TO_DROP" ]; then
  log "retention: dropping $(echo "$TO_DROP" | wc -l | tr -d ' ') old snapshot(s)"
  echo "$TO_DROP" | xargs -r rm -rf
fi

log "backup ok → $DEST"
