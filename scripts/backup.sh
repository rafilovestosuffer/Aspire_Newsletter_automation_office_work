#!/usr/bin/env bash
# Daily SoR + frozen HTML backup. Never dumps GHL subscriber lists (we do not store them).
set -euo pipefail

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
ARTIFACT_DIR="${ARTIFACT_DIR:-$ROOT/artifacts}"
OUT="$BACKUP_DIR/$STAMP"
mkdir -p "$OUT"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

pg_dump "$DATABASE_URL" > "$OUT/newsletter.sql"
if [[ -d "$ARTIFACT_DIR" ]]; then
  cp -a "$ARTIFACT_DIR" "$OUT/artifacts"
fi
echo "wrote $OUT"
