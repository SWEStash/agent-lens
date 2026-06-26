#!/usr/bin/env bash
#
# Agent Lens — Stage 1 collection (ADR-001, ADR-002, ADR-005).
#
# Passively copies agent session traces out of each configured source into a local archive before
# the agent prunes them. Never deletes, never sends data off the machine, never copies secrets.
#
# Sources are resolved by scripts/sources.mjs (see agent-lens.config.json). Each source is a labeled
# agent instance (e.g. "personal" -> ~/.claude) and lands in data/archive/<label>/.
#
# Per-source strategy (refined from empirical rsync testing — see ADR-002):
#   - Mirror grows via `rsync --append-verify` (in-place appends, skips shrunk files, safe on
#     divergence). NO `--delete` so pruned files are retained.
#   - A prefix-check pre-pass snapshots into .versions/<ts>/ ONLY the lossy cases:
#       * divergence (archive not a byte-prefix of a same-or-longer source) -> snapshot OLD archive
#       * compaction (source shorter than archive)                          -> snapshot the SOURCE
#   - Stage 2 ingests the mirror AND .versions/, deduping events by `uuid` -> maximal history.
#
set -euo pipefail
umask 077  # archive is as sensitive as the originals

usage() {
  cat <<'EOF'
Agent Lens — collect agent session traces into the local archive.

Usage: collect.sh [--help]

Sources come from scripts/sources.mjs (agent-lens.config.json: label + configDir per source).
Each source lands in data/archive/<label>/ (projects/**.jsonl, history.jsonl, settings/).

Environment:
  AGENT_LENS_DATA      Base data dir (default: <repo>/data)
  AGENT_LENS_ARCHIVE   Archive base   (default: $AGENT_LENS_DATA/archive)
  AGENT_LENS_CONFIG    Path to a sources config JSON (overrides the default lookup)
  CLAUDE_DIR           Legacy single-source override (label from $AGENT_LENS_LABEL, default "default")

Never copies .credentials.json or any secret/lock file.
EOF
}

[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && { usage; exit 0; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DATA_DIR="${AGENT_LENS_DATA:-$REPO_ROOT/data}"
ARCHIVE_BASE="${AGENT_LENS_ARCHIVE:-$DATA_DIR/archive}"
TS="$(date +%Y%m%dT%H%M%S%3N)"
LOG="$ARCHIVE_BASE/.collect.log"

command -v rsync >/dev/null 2>&1 || { echo "agent-lens: rsync is required but not installed" >&2; exit 1; }
command -v node  >/dev/null 2>&1 || { echo "agent-lens: node is required to resolve sources" >&2; exit 1; }

mkdir -p "$ARCHIVE_BASE"

# Collect one source: $1 = label, $2 = source config dir.
collect_one() {
  local label="$1" claude_dir="$2"
  local archive="$ARCHIVE_BASE/$label"
  local versions="$archive/.versions/$TS"

  if [[ ! -d "$claude_dir" ]]; then
    echo "agent-lens: [$label] source not found: $claude_dir (skipping)" >&2
    return 0
  fi
  mkdir -p "$archive/projects" "$archive/settings"

  local snapshots=0 scanned=0
  snapshot() {
    local abs="$1" rel="$2" dst="$versions/$2"
    mkdir -p "$(dirname "$dst")"
    cp -p "$abs" "$dst"
    snapshots=$((snapshots + 1))
  }

  # --- Pre-pass: snapshot lossy cases before rsync runs ---
  local src_args=("$claude_dir/projects")
  [[ -f "$claude_dir/history.jsonl" ]] && src_args+=("$claude_dir/history.jsonl")

  local src rel arc asize ssize
  while IFS= read -r -d '' src; do
    scanned=$((scanned + 1))
    rel="${src#"$claude_dir"/}"
    arc="$archive/$rel"
    [[ -f "$arc" ]] || continue
    cmp -s "$src" "$arc" && continue

    asize=$(stat -c%s "$arc")
    ssize=$(stat -c%s "$src")
    if [[ "$ssize" -ge "$asize" ]] && head -c "$asize" "$src" | cmp -s - "$arc"; then
      :                                  # pure append -> rsync appends
    elif [[ "$ssize" -lt "$asize" ]]; then
      snapshot "$src" "$rel"             # compaction -> capture compacted source
    else
      snapshot "$arc" "$rel"             # divergence -> capture old archive
    fi
  done < <(find "${src_args[@]}" -type f -name '*.jsonl' -print0 2>/dev/null)

  # --- Mirror update via rsync (append-verify, no --delete, no --backup) ---
  local rsync_common=(-a --append-verify --exclude='.credentials.json' --exclude='*.lock')
  rsync "${rsync_common[@]}" \
    --include='*/' --include='*.jsonl' --exclude='*' \
    "$claude_dir/projects/" "$archive/projects/"
  if [[ -f "$claude_dir/history.jsonl" ]]; then
    rsync "${rsync_common[@]}" "$claude_dir/history.jsonl" "$archive/history.jsonl"
  fi

  # --- Settings: latest-wins, snapshot old on change ---
  local f s a
  for f in settings.json settings.local.json; do
    s="$claude_dir/$f"
    [[ -f "$s" ]] || continue
    a="$archive/settings/$f"
    if [[ -f "$a" ]] && ! cmp -s "$s" "$a"; then snapshot "$a" "settings/$f"; fi
    cp -p "$s" "$a"
  done

  find "$archive" -name '.credentials.json' -delete 2>/dev/null || true

  local line="$(date -Iseconds) run=$TS source=$label scanned=$scanned snapshots=$snapshots archive=$archive"
  echo "agent-lens: $line"
  printf '%s\n' "$line" >> "$LOG"
}

# Iterate configured sources (label \t agent \t configDir).
found_any=0
while IFS=$'\t' read -r label agent configdir; do
  [[ -z "$label" ]] && continue
  found_any=1
  collect_one "$label" "$configdir"
done < <(node "$SCRIPT_DIR/sources.mjs")

[[ "$found_any" -eq 1 ]] || { echo "agent-lens: no sources configured" >&2; exit 1; }
