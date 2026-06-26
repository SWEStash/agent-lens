#!/usr/bin/env bash
#
# Agent Lens — Stage 2 ingest (ADR-001, ADR-003).
#
# Reads the raw archive built by Stage 1 (scripts/collect.sh) — the mirror AND .versions/ divergence
# backups — deduplicates events by `uuid`, and (re)builds the normalized SQLite store. Idempotent:
# unchanged files are skipped and events insert with ON CONFLICT DO NOTHING, so re-runs are cheap.
#
# This wrapper exists so systemd (and humans) can run Stage 2 with the same absolute-path, no-PATH
# assumptions as collect.sh: it invokes the built CLI directly with `node` (matching the package
# `start` script) rather than relying on pnpm being on PATH. Any args are passed through, e.g.:
#   ingest.sh --full          # ignore ingest_state and re-read every file
#
set -euo pipefail

[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && {
  cat <<'EOF'
Agent Lens — build the derived SQLite projection from the local archive.

Usage: ingest.sh [--full] [--db <path>] [--archive <path>]
  --full   ignore ingest_state and re-read every file

Environment:
  AGENT_LENS_DATA      Base data dir (default: <repo>/data)
  AGENT_LENS_ARCHIVE   Archive base   (default: $AGENT_LENS_DATA/archive)
  AGENT_LENS_DB        SQLite path    (default: $AGENT_LENS_DATA/agent-lens.db)
EOF
  exit 0
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRY="$REPO_ROOT/packages/ingest/dist/index.js"

command -v node >/dev/null 2>&1 || { echo "agent-lens: node is required to ingest" >&2; exit 1; }
[[ -f "$ENTRY" ]] || {
  echo "agent-lens: ingest is not built ($ENTRY missing) — run 'pnpm build' first" >&2
  exit 1
}

exec node "$ENTRY" "$@"
