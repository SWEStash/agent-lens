#!/usr/bin/env bash
#
# Agent Lens — Stage 1 collection (ADR-001, ADR-002, ADR-005).
#
# Passively copies Claude Code session traces out of ~/.claude into a local archive before the
# harness prunes them (rolling 30-day window). Never deletes, never sends data off the machine,
# never copies secrets.
#
# Strategy (refined from empirical rsync testing — see ADR-002):
#   - Mirror grows via `rsync --append-verify` (in-place appends, skips shrunk files, safe on
#     divergence). NO `--delete` so 30-day-pruned files are retained.
#   - We do NOT use rsync's own `--backup`: it backs up on *every* append, bloating .versions/.
#     Instead a prefix-check pre-pass snapshots into .versions/<ts>/ ONLY the two lossy cases:
#       * divergence (archive is not a byte-prefix of a same-or-longer source) -> snapshot OLD archive
#       * compaction (source shorter than archive)                              -> snapshot the
#         compacted SOURCE (rsync would skip it, so its new events would otherwise be lost)
#   - Stage 2 ingests the mirror AND all .versions/ backups, deduping events by `uuid` -> maximal
#     history, recovering compaction-dropped events.
#
set -euo pipefail
umask 077  # archive is as sensitive as the originals

usage() {
  cat <<'EOF'
Agent Lens — collect Claude Code session traces into the local archive.

Usage: collect.sh [--help]

Environment:
  CLAUDE_DIR             Source dir (default: $HOME/.claude)
  AGENT_LENS_DATA        Base data dir (default: <repo>/data)
  AGENT_LENS_ARCHIVE     Destination archive (default: $AGENT_LENS_DATA/archive)

Copies (.jsonl only):  $CLAUDE_DIR/projects/**, $CLAUDE_DIR/history.jsonl
Copies (latest-wins):  settings.json, settings.local.json
Never copies:          .credentials.json or any secret/lock file.
EOF
}

[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && { usage; exit 0; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
DATA_DIR="${AGENT_LENS_DATA:-$REPO_ROOT/data}"
ARCHIVE="${AGENT_LENS_ARCHIVE:-$DATA_DIR/archive}"
TS="$(date +%Y%m%dT%H%M%S%3N)"
VERSIONS="$ARCHIVE/.versions/$TS"
LOG="$ARCHIVE/.collect.log"

if [[ ! -d "$CLAUDE_DIR" ]]; then
  echo "agent-lens: source not found: $CLAUDE_DIR" >&2
  exit 1
fi
if ! command -v rsync >/dev/null 2>&1; then
  echo "agent-lens: rsync is required but not installed" >&2
  exit 1
fi

mkdir -p "$ARCHIVE/projects" "$ARCHIVE/settings"

snapshots=0
log() { printf '%s\n' "$*"; }

# Save <abs_file> under .versions/<ts>/<relpath>, preserving directory structure.
snapshot() {
  local abs="$1" rel="$2" dst
  dst="$VERSIONS/$rel"
  mkdir -p "$(dirname "$dst")"
  cp -p "$abs" "$dst"
  snapshots=$((snapshots + 1))
}

# --- Pre-pass: detect lossy cases and snapshot them before rsync runs ---------
# Build the list of source .jsonl files that already exist in the archive and differ.
src_args=("$CLAUDE_DIR/projects")
[[ -f "$CLAUDE_DIR/history.jsonl" ]] && src_args+=("$CLAUDE_DIR/history.jsonl")

scanned=0
while IFS= read -r -d '' src; do
  scanned=$((scanned + 1))
  rel="${src#"$CLAUDE_DIR"/}"
  arc="$ARCHIVE/$rel"
  [[ -f "$arc" ]] || continue            # new file: rsync will copy it, nothing to preserve
  cmp -s "$src" "$arc" && continue       # identical: nothing changed

  asize=$(stat -c%s "$arc")
  ssize=$(stat -c%s "$src")

  if [[ "$ssize" -ge "$asize" ]] && head -c "$asize" "$src" | cmp -s - "$arc"; then
    :                                    # pure append: archive is a prefix of source -> rsync appends
  elif [[ "$ssize" -lt "$asize" ]]; then
    snapshot "$src" "$rel"               # compaction: capture compacted source (rsync will skip it)
  else
    snapshot "$arc" "$rel"               # divergence: capture old archive before rsync overwrites it
  fi
done < <(find "${src_args[@]}" -type f -name '*.jsonl' -print0 2>/dev/null)

# --- Mirror update via rsync (append-verify, no --delete, no --backup) ---------
RSYNC_COMMON=(-a --append-verify --exclude='.credentials.json' --exclude='*.lock')

# Transcripts: only *.jsonl from projects/.
rsync "${RSYNC_COMMON[@]}" \
  --include='*/' --include='*.jsonl' --exclude='*' \
  "$CLAUDE_DIR/projects/" "$ARCHIVE/projects/"

# Global prompt history (append-only).
if [[ -f "$CLAUDE_DIR/history.jsonl" ]]; then
  rsync "${RSYNC_COMMON[@]}" "$CLAUDE_DIR/history.jsonl" "$ARCHIVE/history.jsonl"
fi

# --- Settings: latest-wins, snapshot old on change (small, non-secret) ---------
for f in settings.json settings.local.json; do
  src="$CLAUDE_DIR/$f"
  [[ -f "$src" ]] || continue
  arc="$ARCHIVE/settings/$f"
  if [[ -f "$arc" ]] && ! cmp -s "$src" "$arc"; then
    snapshot "$arc" "settings/$f"
  fi
  cp -p "$src" "$arc"
done

# Safety: ensure no credentials slipped in.
find "$ARCHIVE" -name '.credentials.json' -delete 2>/dev/null || true

line="$(date -Iseconds) run=$TS scanned=$scanned snapshots=$snapshots archive=$ARCHIVE"
log "agent-lens: $line"
printf '%s\n' "$line" >> "$LOG"
