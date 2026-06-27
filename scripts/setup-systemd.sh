#!/usr/bin/env bash
#
# Agent Lens — install/uninstall the *user* systemd units (no root):
#   data-load : a timer that runs Stage 1 collection + Stage 2 ingest, a few times a day (ADR-002).
#   web-ui    : a long-running service for the local web UI + read-only API (ADR-005).
#
# Linger is enabled so units run even when you are not logged in.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COLLECT_SH="$SCRIPT_DIR/collect.sh"
INGEST_SH="$SCRIPT_DIR/ingest.sh"
SERVE_SH="$SCRIPT_DIR/serve.sh"
UNIT_SRC="$REPO_ROOT/systemd"
UNIT_DST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

# Unit groupings per install target.
DATA_UNITS=(agent-lens-collect.service agent-lens-collect.timer)
WEB_UNITS=(agent-lens-server.service)
ALL_UNITS=("${DATA_UNITS[@]}" "${WEB_UNITS[@]}")

usage() {
  cat <<EOF
Agent Lens — systemd (user) setup.

Usage: setup-systemd.sh <command> [target]

Commands:
  install [target]   Install + enable + start units (and enable linger).
  uninstall          Stop, disable, and remove ALL units.
  status             Show timer/service status.

Install targets (default: all):
  all          Data collection+ingest timer AND the web UI server.
  data-load    Only the collection+ingest timer (Stage 1 + Stage 2).
  web-ui       Only the web UI + API server (Stage 3).
EOF
}

require_systemd() {
  command -v systemctl >/dev/null 2>&1 || { echo "agent-lens: systemctl not found" >&2; exit 1; }
}

# Render the given unit files into the user unit dir, substituting absolute paths.
render_units() {
  mkdir -p "$UNIT_DST"
  local u
  for u in "$@"; do
    sed -e "s#__COLLECT_SH__#$COLLECT_SH#g" \
        -e "s#__INGEST_SH__#$INGEST_SH#g" \
        -e "s#__SERVE_SH__#$SERVE_SH#g" \
        -e "s#__REPO_ROOT__#$REPO_ROOT#g" \
        "$UNIT_SRC/$u" > "$UNIT_DST/$u"
  done
}

enable_linger() {
  # Let units run when logged out. Non-fatal if it isn't permitted.
  if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$USER" 2>/dev/null \
      || echo "agent-lens: could not enable linger automatically; run: sudo loginctl enable-linger $USER"
  fi
}

install_units() {
  require_systemd
  local target="${1:-all}"
  local want_data=0 want_web=0
  case "$target" in
    all)       want_data=1; want_web=1 ;;
    data-load) want_data=1 ;;
    web-ui)    want_web=1 ;;
    *) echo "agent-lens: unknown install target '$target' (use: all | data-load | web-ui)" >&2; exit 1 ;;
  esac

  local units=()
  [[ $want_data -eq 1 ]] && { chmod +x "$COLLECT_SH" "$INGEST_SH"; units+=("${DATA_UNITS[@]}"); }
  [[ $want_web  -eq 1 ]] && { chmod +x "$SERVE_SH";               units+=("${WEB_UNITS[@]}"); }

  render_units "${units[@]}"
  systemctl --user daemon-reload

  if [[ $want_data -eq 1 ]]; then
    systemctl --user enable --now agent-lens-collect.timer
  fi
  if [[ $want_web -eq 1 ]]; then
    systemctl --user enable --now agent-lens-server.service
  fi

  enable_linger

  echo "agent-lens: installed ($target)."
  [[ $want_data -eq 1 ]] && systemctl --user list-timers agent-lens-collect.timer --no-pager || true
  [[ $want_web  -eq 1 ]] && systemctl --user --no-pager status agent-lens-server.service 2>/dev/null | head -3 || true
}

uninstall_units() {
  require_systemd
  systemctl --user disable --now agent-lens-collect.timer 2>/dev/null || true
  systemctl --user disable --now agent-lens-server.service 2>/dev/null || true
  local u
  for u in "${ALL_UNITS[@]}"; do rm -f "$UNIT_DST/$u"; done
  systemctl --user daemon-reload
  echo "agent-lens: uninstalled (linger left unchanged; archive untouched)."
}

status_units() {
  require_systemd
  systemctl --user list-timers agent-lens-collect.timer --no-pager 2>/dev/null || true
  echo
  systemctl --user status agent-lens-collect.service --no-pager 2>/dev/null || true
  echo
  systemctl --user status agent-lens-server.service --no-pager 2>/dev/null || true
}

case "${1:-}" in
  install)   install_units "${2:-all}" ;;
  uninstall) uninstall_units ;;
  status)    status_units ;;
  ""|-h|--help) usage ;;
  *) echo "agent-lens: unknown command '$1'" >&2; usage; exit 1 ;;
esac
