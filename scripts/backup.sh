#!/usr/bin/env bash
# Daily SoR + frozen HTML backup.
#
# Never dumps GHL subscriber lists — we do not store them (docs/COMPLIANCE.md).
#
# Environment:
#   DATABASE_URL            required
#   BACKUP_DIR              where to write        (default <repo>/backups)
#   ARTIFACT_DIR            frozen issues to copy (default <repo>/artifacts)
#   BACKUP_RETENTION_DAYS   prune older than this (default 14, 0 disables)
#   BACKUP_REMOTE           optional off-box rsync target, e.g. user@host:/srv/bk
#
# Exits non-zero on any failure, having left no partial backup behind.
set -euo pipefail

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
ARTIFACT_DIR="${ARTIFACT_DIR:-$ROOT/artifacts}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
OUT="$BACKUP_DIR/$STAMP"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

# Build in a sibling .partial and rename only once everything succeeded, so a
# failed run can never leave something that looks like a usable backup. The old
# version redirected pg_dump straight into the final path, which created the
# file before the dump ran: a dump that died halfway left a truncated .sql that
# a restore would happily read as a complete one.
PARTIAL="$OUT.partial"
rm -rf "$PARTIAL"
mkdir -p "$PARTIAL"
cleanup() { rm -rf "$PARTIAL"; }
trap cleanup EXIT

echo "backing up to $OUT"

# --- database ---------------------------------------------------------------
# Custom format: compressed, and restorable with pg_restore --clean into a
# scratch database, which is what scripts/restore-drill.sh exercises.
pg_dump --format=custom --no-owner --no-privileges \
  --file="$PARTIAL/newsletter.dump" "$DATABASE_URL"

# A dump that wrote nothing useful is worse than no dump, because it silences
# the alarm. pg_restore --list fails on a truncated or corrupt archive.
if ! pg_restore --list "$PARTIAL/newsletter.dump" > "$PARTIAL/manifest.txt" 2>/dev/null; then
  echo "pg_dump produced an archive pg_restore cannot read" >&2
  exit 1
fi

TABLES="$(grep -c 'TABLE DATA' "$PARTIAL/manifest.txt" || true)"
if [[ "$TABLES" -lt 1 ]]; then
  echo "dump contains no table data (expected issues, outbox, issue_events, ...)" >&2
  exit 1
fi
echo "  database: $(du -h "$PARTIAL/newsletter.dump" | cut -f1), $TABLES tables with data"

# --- frozen artifacts -------------------------------------------------------
# Sent revisions are immutable, so a plain copy is correct; tar keeps it to one
# file and one checksum.
if [[ -d "$ARTIFACT_DIR" ]]; then
  tar -czf "$PARTIAL/artifacts.tar.gz" -C "$(dirname "$ARTIFACT_DIR")" "$(basename "$ARTIFACT_DIR")"
  echo "  artifacts: $(du -h "$PARTIAL/artifacts.tar.gz" | cut -f1)"
else
  echo "  artifacts: none at $ARTIFACT_DIR"
fi

# --- checksums --------------------------------------------------------------
# So a restore can prove it is reading what was written, not a bit-rotted copy.
( cd "$PARTIAL" && sha256sum newsletter.dump artifacts.tar.gz 2>/dev/null > SHA256SUMS || \
  sha256sum newsletter.dump > SHA256SUMS )

# Commit the backup.
mkdir -p "$BACKUP_DIR"
mv "$PARTIAL" "$OUT"
trap - EXIT
echo "wrote $OUT"

# --- off-box copy -----------------------------------------------------------
# A backup on the same VPS does not survive losing the VPS. Optional, but when
# configured a failure is fatal: a silent skip is how you discover at restore
# time that nothing ever left the box.
if [[ -n "${BACKUP_REMOTE:-}" ]]; then
  echo "copying to $BACKUP_REMOTE"
  rsync -a --checksum "$OUT" "$BACKUP_REMOTE/"
  echo "off-box copy complete"
else
  echo "BACKUP_REMOTE unset: this backup exists only on this host"
fi

# --- retention --------------------------------------------------------------
# Prune by age, but never leave zero backups: if everything is older than the
# window (the job stopped running), keeping the newest beats keeping none.
if [[ "$RETENTION_DAYS" -gt 0 ]]; then
  mapfile -t ALL < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*' | sort)
  if [[ ${#ALL[@]} -gt 1 ]]; then
    for dir in "${ALL[@]:0:${#ALL[@]}-1}"; do
      if [[ -n "$(find "$dir" -maxdepth 0 -mtime "+$RETENTION_DAYS")" ]]; then
        echo "pruning $dir (older than ${RETENTION_DAYS}d)"
        rm -rf "$dir"
      fi
    done
  fi
fi
