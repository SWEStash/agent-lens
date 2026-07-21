#!/usr/bin/env bash
#
# Agent Lens — retention pruning (ADR-009).
#
# Deletes old divergence/compaction snapshots under data/archive/<label>/.versions/<TS>/ once they
# age past a retention window. This is the ONLY archive growth that is both unbounded and safely
# discardable: the projects/ mirror is the retained dataset (never pruned) and the SQLite DB is a
# derived projection (rebuild with `pnpm ingest --full` if a prune ever changes what's available).
#
# DRY-RUN BY DEFAULT: prints what would be removed and the reclaimable size, deletes nothing.
# Pass --apply to actually delete. Never touches projects/, settings/, history.jsonl, or the DB.
#
set -euo pipefail
umask 077  # archive is as sensitive as the originals

DEFAULT_KEEP_DAYS=90

usage() {
  cat <<'EOF'
Agent Lens — prune aged .versions/ snapshots from the local archive.

Usage: prune.sh [--apply] [--days N] [--help]

  (default)     DRY RUN — list snapshot dirs older than the window + reclaimable size; delete nothing.
  --apply       Actually delete the selected .versions/<TS>/ snapshot dirs.
  --days N      Retention window in days (default: $AGENT_LENS_VERSIONS_KEEP_DAYS or 90).
  --help        Show this help.

Only data/archive/*/.versions/<TS>/ snapshot dirs are ever considered. The projects/ mirror,
settings/, history.jsonl, and data/agent-lens.db are never touched.

Environment:
  AGENT_LENS_DATA               Base data dir (default: <repo>/data); the archive is always
                                <dataDir>/archive (ADR-021)
  AGENT_LENS_VERSIONS_KEEP_DAYS Default retention window in days (default: 90)
EOF
}

# --- Args ---
APPLY=0
KEEP_DAYS="${AGENT_LENS_VERSIONS_KEEP_DAYS:-$DEFAULT_KEEP_DAYS}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --apply) APPLY=1; shift ;;
    --days) KEEP_DAYS="${2:?--days needs a value}"; shift 2 ;;
    --days=*) KEEP_DAYS="${1#*=}"; shift ;;
    *) echo "agent-lens: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done
[[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] || { echo "agent-lens: --days must be a non-negative integer" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="${AGENT_LENS_DATA:-$REPO_ROOT/data}"
ARCHIVE_BASE="$DATA_DIR/archive"
LOG="$ARCHIVE_BASE/.prune.log"

if [[ ! -d "$ARCHIVE_BASE" ]]; then
  echo "agent-lens: archive not found: $ARCHIVE_BASE (run \`agent-lens collect\` first)" >&2
  exit 1
fi

NOW="$(date +%s)"
CUTOFF=$((NOW - KEEP_DAYS * 86400))

# Resolve a snapshot dir's creation time to an epoch. The dir name is the collector's run stamp
# (date +%Y%m%dT%H%M%S%3N, e.g. 20260626T120000123); fall back to the dir's mtime if it won't parse.
ts_epoch() {
  local dir="$1" name d t e
  name="$(basename "$dir")"
  if [[ "$name" =~ ^([0-9]{8})T([0-9]{6})[0-9]{0,3}$ ]]; then
    d="${BASH_REMATCH[1]}"; t="${BASH_REMATCH[2]}"
    e="$(date -d "${d:0:4}-${d:4:2}-${d:6:2} ${t:0:2}:${t:2:2}:${t:4:2}" +%s 2>/dev/null || true)"
    [[ -n "$e" ]] && { echo "$e"; return; }
  fi
  stat -c %Y "$dir" 2>/dev/null || echo "$NOW"
}

# --- Scan .versions/<TS> dirs across all source labels ---
total=0 pruned=0 bytes=0
shopt -s nullglob
for versions_dir in "$ARCHIVE_BASE"/*/.versions; do
  [[ -d "$versions_dir" ]] || continue
  for snap in "$versions_dir"/*; do
    [[ -d "$snap" ]] || continue
    # Hard safety guard: only ever act on a path that is a .versions/<TS> snapshot dir.
    case "$snap" in */.versions/*) : ;; *) continue ;; esac
    total=$((total + 1))
    epoch="$(ts_epoch "$snap")"
    [[ "$epoch" -lt "$CUTOFF" ]] || continue

    size_kb="$(du -sk "$snap" 2>/dev/null | cut -f1)"; size_kb="${size_kb:-0}"
    bytes=$((bytes + size_kb * 1024))
    pruned=$((pruned + 1))
    age_days=$(((NOW - epoch) / 86400))
    if [[ "$APPLY" -eq 1 ]]; then
      echo "agent-lens: removing $snap (age ${age_days}d)"
      rm -rf -- "$snap"
    else
      echo "agent-lens: would remove $snap (age ${age_days}d, $((size_kb / 1024)) MB)"
    fi
  done
done

mode=$([[ "$APPLY" -eq 1 ]] && echo apply || echo dry-run)
human_mb=$((bytes / 1024 / 1024))

if [[ "$pruned" -eq 0 ]]; then
  echo "agent-lens: nothing to prune (${total} snapshot dir(s) scanned, all within ${KEEP_DAYS}d window)"
else
  verb=$([[ "$APPLY" -eq 1 ]] && echo "pruned" || echo "would prune")
  echo "agent-lens: ${verb} ${pruned}/${total} snapshot dir(s), ~${human_mb} MB (window ${KEEP_DAYS}d, mode ${mode})"
fi

line="$(date -Iseconds) mode=$mode keep_days=$KEEP_DAYS scanned=$total pruned=$pruned bytes=$bytes"
printf '%s\n' "$line" >> "$LOG"
