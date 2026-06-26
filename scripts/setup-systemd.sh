#!/usr/bin/env bash
#
# Agent Lens — install/uninstall the user systemd timer that runs Stage 1 collection (ADR-002).
#
# Uses a *user* systemd instance (no root) and enables linger so the timer fires even when you are
# not logged in.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COLLECT_SH="$SCRIPT_DIR/collect.sh"
UNIT_SRC="$REPO_ROOT/systemd"
UNIT_DST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNITS=(agent-lens-collect.service agent-lens-collect.timer)

usage() {
  cat <<EOF
Agent Lens — systemd timer setup.

Usage: setup-systemd.sh <command>

Commands:
  install     Install + enable + start the collection timer (and enable linger).
  uninstall   Stop, disable, and remove the units.
  status      Show timer/service status and next run.
EOF
}

require_systemd() {
  command -v systemctl >/dev/null 2>&1 || { echo "agent-lens: systemctl not found" >&2; exit 1; }
}

install_units() {
  require_systemd
  chmod +x "$COLLECT_SH"
  mkdir -p "$UNIT_DST"
  for u in "${UNITS[@]}"; do
    sed -e "s#__COLLECT_SH__#$COLLECT_SH#g" \
        -e "s#__REPO_ROOT__#$REPO_ROOT#g" \
        "$UNIT_SRC/$u" > "$UNIT_DST/$u"
  done
  systemctl --user daemon-reload
  systemctl --user enable --now agent-lens-collect.timer

  # Let the timer run when logged out. Non-fatal if it isn't permitted.
  if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$USER" 2>/dev/null \
      || echo "agent-lens: could not enable linger automatically; run: sudo loginctl enable-linger $USER"
  fi

  echo "agent-lens: installed. Next runs:"
  systemctl --user list-timers agent-lens-collect.timer --no-pager || true
}

uninstall_units() {
  require_systemd
  systemctl --user disable --now agent-lens-collect.timer 2>/dev/null || true
  for u in "${UNITS[@]}"; do rm -f "$UNIT_DST/$u"; done
  systemctl --user daemon-reload
  echo "agent-lens: uninstalled (linger left unchanged; archive untouched)."
}

status_units() {
  require_systemd
  systemctl --user list-timers agent-lens-collect.timer --no-pager || true
  echo
  systemctl --user status agent-lens-collect.service --no-pager || true
}

case "${1:-}" in
  install)   install_units ;;
  uninstall) uninstall_units ;;
  status)    status_units ;;
  ""|-h|--help) usage ;;
  *) echo "agent-lens: unknown command '$1'" >&2; usage; exit 1 ;;
esac
