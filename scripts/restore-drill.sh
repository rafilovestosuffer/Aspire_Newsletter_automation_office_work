#!/usr/bin/env bash
# Prove a backup restores. An untested backup is not a backup.
#
# Restores the newest (or a named) backup into a scratch database, then checks
# that the schema and the row counts that matter actually came back. Drops the
# scratch database afterwards. Never touches the source database.
#
# Environment:
#   DATABASE_URL   required — the live database, read for comparison only
#   BACKUP_DIR     where backups live (default <repo>/backups)
#   DRILL_DB       scratch database name (default newsletter_drill)
#   KEEP_DRILL_DB  set to 1 to leave the scratch database for inspection
#
# Usage:
#   ./scripts/restore-drill.sh                 # newest backup
#   ./scripts/restore-drill.sh 20260821T120000Z
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
DRILL_DB="${DRILL_DB:-newsletter_drill}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

if [[ $# -ge 1 ]]; then
  SRC="$BACKUP_DIR/$1"
else
  SRC="$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*' | sort | tail -1)"
fi

if [[ -z "$SRC" || ! -d "$SRC" ]]; then
  echo "no backup found in $BACKUP_DIR" >&2
  exit 1
fi
echo "drilling $SRC"

# --- integrity --------------------------------------------------------------
if [[ -f "$SRC/SHA256SUMS" ]]; then
  ( cd "$SRC" && sha256sum --quiet --check SHA256SUMS )
  echo "  checksums OK"
else
  echo "  WARNING: no SHA256SUMS in this backup" >&2
fi

# --- restore into a scratch database ----------------------------------------
# Same server, different database. Derived by swapping the path component, so
# the drill uses the same credentials without a second secret to manage.
ADMIN_URL="${DATABASE_URL%/*}/postgres"
DRILL_URL="${DATABASE_URL%/*}/$DRILL_DB"

cleanup() {
  if [[ "${KEEP_DRILL_DB:-0}" != "1" ]]; then
    psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $DRILL_DB" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $DRILL_DB"
psql "$ADMIN_URL" -q -c "CREATE DATABASE $DRILL_DB"

# --no-owner/--no-privileges because the drill database is owned by whoever ran
# the drill, not by production's role.
pg_restore --no-owner --no-privileges --dbname="$DRILL_URL" "$SRC/newsletter.dump"
echo "  restored into $DRILL_DB"

# --- verify what came back --------------------------------------------------
FAIL=0

# Schema: the tables the control plane cannot run without.
for t in issues content_items issue_items approval_tokens issue_events outbox kill_state schema_migrations; do
  if ! psql "$DRILL_URL" -tAc "SELECT to_regclass('public.$t')" | grep -q "$t"; then
    echo "  MISSING TABLE: $t" >&2
    FAIL=1
  fi
done
[[ "$FAIL" -eq 0 ]] && echo "  schema OK (8 tables)"

# The append-only guarantee is a trigger, and a restore that silently drops it
# would leave the audit trail editable without anything looking wrong.
if psql "$DRILL_URL" -tAc \
  "SELECT count(*) FROM pg_trigger WHERE tgname = 'issue_events_no_update'" | grep -q '^1$'; then
  echo "  issue_events append-only trigger restored"
else
  echo "  MISSING TRIGGER: issue_events_no_update (audit trail would be mutable)" >&2
  FAIL=1
fi

# Row counts against the live database. The backup is older than "now", so the
# restore may legitimately have fewer rows — never more.
for t in issues content_items issue_events outbox; do
  LIVE="$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM $t")"
  BACK="$(psql "$DRILL_URL"    -tAc "SELECT count(*) FROM $t")"
  if [[ "$BACK" -gt "$LIVE" ]]; then
    echo "  $t: restored $BACK > live $LIVE — backup is not from this database" >&2
    FAIL=1
  else
    echo "  $t: restored $BACK / live $LIVE"
  fi
done

# Frozen artifacts, if the backup carried them.
if [[ -f "$SRC/artifacts.tar.gz" ]]; then
  if tar -tzf "$SRC/artifacts.tar.gz" >/dev/null 2>&1; then
    echo "  artifacts archive readable ($(tar -tzf "$SRC/artifacts.tar.gz" | wc -l) entries)"
  else
    echo "  artifacts.tar.gz is unreadable" >&2
    FAIL=1
  fi
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "RESTORE DRILL FAILED" >&2
  exit 1
fi
echo "RESTORE DRILL PASSED — $SRC restores cleanly"
