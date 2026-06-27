#!/usr/bin/env bash
#
# Agent Lens — Stage 3 server (ADR-005): serves the built web UI + a read-only REST API over the
# SQLite store. Binds 127.0.0.1 only by default (no egress); see packages/server for env knobs.
#
# Like ingest.sh, this wrapper exists so systemd (and humans) launch the server with the same
# absolute-path, no-PATH assumptions: it invokes the built entrypoint directly with `node` rather
# than relying on pnpm being on PATH.
#
#   AGENT_LENS_PORT   listen port  (default 4477)
#   AGENT_LENS_HOST   bind host    (default 127.0.0.1)
#   AGENT_LENS_DB     SQLite path  (default <repo>/data/agent-lens.db)
#
set -euo pipefail

[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && {
  cat <<'EOF'
Agent Lens — run the local web UI + read-only API server.

Usage: serve.sh

Environment:
  AGENT_LENS_PORT   listen port (default 4477)
  AGENT_LENS_HOST   bind host   (default 127.0.0.1; non-loopback needs AGENT_LENS_ALLOW_NONLOCAL=1)
  AGENT_LENS_DB     SQLite path (default <repo>/data/agent-lens.db)
EOF
  exit 0
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRY="$REPO_ROOT/packages/server/dist/index.js"

command -v node >/dev/null 2>&1 || { echo "agent-lens: node is required to serve" >&2; exit 1; }
[[ -f "$ENTRY" ]] || {
  echo "agent-lens: server is not built ($ENTRY missing) — run 'pnpm build' first" >&2
  exit 1
}

exec node "$ENTRY" "$@"
