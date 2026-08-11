#!/usr/bin/env bash
#
# End-to-end sanity check of the PUBLISHED npm package, run against a real machine.
#
# This is a manual release gate, not a CI job: it needs a live systemd user session and a real
# Claude install with sessions in it, neither of which exists on a runner. Run it after publishing
# and before announcing a release.
#
# It installs @swestash/agent-lens from npm into an isolated prefix under /tmp, points it at an
# isolated data dir and port, exercises install → systemd → collect → ingest → DB → triage writes →
# web UI, and tears everything down. It never touches an existing agent-lens installation: the
# shipped unit names are hardcoded (packages/core/src/service.ts), so `service install` is run
# against a redirected XDG_CONFIG_HOME with a systemctl shim, and the real systemd run uses units
# renamed to agent-lens-sanity-*.
#
#   scripts/sanity-e2e.sh [--version <v>] [--port <n>] [--source <dir>] [--keep]
#
set -uo pipefail

VERSION=latest
PORT=4488
SOURCE_DIR="$HOME/.claude"
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --source) SOURCE_DIR="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT=/tmp/agent-lens-sanity
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
PREFIX=agent-lens-sanity
AL="$ROOT/npm-global/bin/agent-lens"
PASS=0
FAIL=0

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
# check <description> <expected-substring> <<< actual   — the workhorse assertion.
check() { local d="$1" e="$2" a; a=$(cat); case "$a" in *"$e"*) ok "$d" ;; *) bad "$d (wanted '$e', got: $(echo "$a" | head -2 | tr '\n' ' '))" ;; esac; }

# ---- teardown ------------------------------------------------------------------------------------
# A trap, so an aborted run never leaves test units loaded on the developer's machine.
teardown() {
  [ "$KEEP" = 1 ] && { echo; echo "--keep: left $ROOT and the $PREFIX-* units in place."; return; }
  say "Teardown"
  systemctl --user disable --now "$PREFIX-collect.timer" >/dev/null 2>&1
  systemctl --user disable --now "$PREFIX-server.service" >/dev/null 2>&1
  systemctl --user stop "$PREFIX-collect.service" >/dev/null 2>&1
  rm -f "$UNIT_DIR/$PREFIX-"*
  systemctl --user daemon-reload >/dev/null 2>&1
  systemctl --user reset-failed "$PREFIX-collect.service" "$PREFIX-server.service" >/dev/null 2>&1
  rm -rf "$ROOT"
  echo "  removed $PREFIX-* units and $ROOT"
}
trap teardown EXIT

# ---- safety baseline -----------------------------------------------------------------------------
# Everything below must leave a pre-existing agent-lens install untouched. Captured now, re-checked
# at the end; any difference fails the run.
say "Safety baseline"
BASE_UNITS=$(sha256sum "$UNIT_DIR"/agent-lens-*.{service,timer} 2>/dev/null | grep -v "$PREFIX" | sort)
BASE_ENABLED=$(systemctl --user list-unit-files 'agent-lens*' --no-legend 2>/dev/null | grep -v "$PREFIX" | awk '{print $1, $2}' | sort)
START_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "  recorded $(echo "$BASE_UNITS" | grep -c . ) existing unit file(s)"

# ---- phase 1: install ----------------------------------------------------------------------------
say "Phase 1 — install from npm"
rm -rf "$ROOT"; mkdir -p "$ROOT"/{npm-global,data,xdg,shim,out}
cat > "$ROOT/agent-lens.config.json" <<JSON
{ "sources": [ { "label": "personal", "agent": "claude-code", "configDir": "$SOURCE_DIR" } ] }
JSON

export npm_config_prefix="$ROOT/npm-global"
export AGENT_LENS_DATA="$ROOT/data"
export AGENT_LENS_CONFIG="$ROOT/agent-lens.config.json"
export AGENT_LENS_PORT="$PORT"

npm install -g "@swestash/agent-lens@$VERSION" >"$ROOT/out/install.log" 2>&1
[ $? -eq 0 ] && ok "npm install exited 0" || { bad "npm install failed — see $ROOT/out/install.log"; exit 1; }
"$AL" --version | check "CLI reports a version" "agent-lens/"
"$AL" --help > "$ROOT/out/help.txt" 2>&1
grep -c '^  [a-z]' "$ROOT/out/help.txt" >/dev/null && ok "--help lists commands"

# A bare install must resolve to the per-user OS data dir, not a repo path.
env -i HOME="$HOME" PATH="$(dirname "$(command -v node)"):/usr/bin:/bin" "$AL" config 2>&1 |
  grep '^  data dir' | check "bare install defaults to the per-user data dir" "$HOME"

# ---- phase 2: config isolation -------------------------------------------------------------------
say "Phase 2 — config resolution"
"$AL" config > "$ROOT/out/config.txt" 2>&1
grep '^  data dir'  "$ROOT/out/config.txt" | check "data dir is isolated"  "$ROOT/data"
grep '^  db '       "$ROOT/out/config.txt" | check "db is isolated"        "$ROOT/data"
grep '^  triage db' "$ROOT/out/config.txt" | check "triage db is isolated" "$ROOT/data"
grep '^  port'      "$ROOT/out/config.txt" | check "port is overridden"    "$PORT"

# ---- phase 3a: unit generation, live systemd untouched -------------------------------------------
say "Phase 3a — service install (shimmed systemctl, redirected XDG_CONFIG_HOME)"
cat > "$ROOT/shim/systemctl" <<'SH'
#!/usr/bin/env bash
echo "systemctl $*" >> "$ROOT_LOG"
SH
cp "$ROOT/shim/systemctl" "$ROOT/shim/loginctl"
sed -i 's/systemctl \$\*/loginctl $*/' "$ROOT/shim/loginctl"
chmod +x "$ROOT/shim/systemctl" "$ROOT/shim/loginctl"

ROOT_LOG="$ROOT/systemctl.log" XDG_CONFIG_HOME="$ROOT/xdg" PATH="$ROOT/shim:$PATH" \
  "$AL" service install --times 8,20 >"$ROOT/out/service-install.log" 2>&1

GEN="$ROOT/xdg/systemd/user"
cat "$GEN/agent-lens-collect.timer"    2>/dev/null | check "timer honours --times"        "08,20:00"
grep '^ExecStart=' "$GEN/agent-lens-collect.service" 2>/dev/null | check "collector bakes an absolute node path" "ExecStart=/"
cat "$GEN/agent-lens-server.service"   2>/dev/null | check "server unit bakes the port"    "AGENT_LENS_PORT=$PORT"
cat "$ROOT/systemctl.log"              2>/dev/null | check "install enables the timer"     "enable --now agent-lens-collect.timer"
NOW_UNITS=$(sha256sum "$UNIT_DIR"/agent-lens-*.{service,timer} 2>/dev/null | grep -v "$PREFIX" | sort)
[ "$NOW_UNITS" = "$BASE_UNITS" ] && ok "existing units untouched by service install" || bad "service install modified existing units"

# ---- phase 3b: real systemd run under renamed units ----------------------------------------------
say "Phase 3b — run under systemd as $PREFIX-*"
ENVB="Environment=AGENT_LENS_DATA=$ROOT/data\nEnvironment=AGENT_LENS_CONFIG=$ROOT/agent-lens.config.json\nEnvironment=AGENT_LENS_PORT=$PORT"
sed -e "s|^Description=|Description=[SANITY TEST] |" -e "/^Type=oneshot/a $ENVB" \
    "$GEN/agent-lens-collect.service" > "$UNIT_DIR/$PREFIX-collect.service"
sed -e "s|^Description=|Description=[SANITY TEST] |" -e "/^\[Timer\]/a Unit=$PREFIX-collect.service" \
    "$GEN/agent-lens-collect.timer" > "$UNIT_DIR/$PREFIX-collect.timer"
sed -e "s|^Description=|Description=[SANITY TEST] |" -e "s|^Environment=AGENT_LENS_PORT=$PORT|$ENVB|" \
    "$GEN/agent-lens-server.service" > "$UNIT_DIR/$PREFIX-server.service"
systemctl --user daemon-reload

# The oneshot collector runs the whole collect+ingest pipeline; drive it directly rather than
# waiting for the clock.
systemctl --user start "$PREFIX-collect.service"
systemctl --user show "$PREFIX-collect.service" -p Result --value | check "collector unit succeeded" "success"
journalctl --user -u "$PREFIX-collect.service" --no-pager -n 40 > "$ROOT/out/collect-journal.txt" 2>&1
grep -c "collect done" "$ROOT/out/collect-journal.txt" >/dev/null && ok "collector logged a collect summary" || bad "no collect summary in the journal"

systemctl --user start "$PREFIX-server.service"; sleep 3
systemctl --user is-active "$PREFIX-server.service" | check "server unit is active" "active"
curl -s --max-time 10 "http://127.0.0.1:$PORT/api/health" | check "health responds on $PORT" '"ok":true'

# Restart=always is the unit's stated contract — prove it rather than trusting the directive.
OLDPID=$(systemctl --user show "$PREFIX-server.service" -p MainPID --value)
kill -TERM "$OLDPID" 2>/dev/null; sleep 8
NEWPID=$(systemctl --user show "$PREFIX-server.service" -p MainPID --value)
[ -n "$NEWPID" ] && [ "$NEWPID" != "0" ] && [ "$NEWPID" != "$OLDPID" ] &&
  ok "Restart=always brought the server back ($OLDPID → $NEWPID)" || bad "server did not restart after SIGTERM"

systemctl --user enable --now "$PREFIX-collect.timer" >/dev/null 2>&1
systemctl --user list-timers "$PREFIX-collect.timer" --no-pager | check "timer is scheduled" "$PREFIX-collect.timer"

# ---- phase 4: collect / ingest / store -----------------------------------------------------------
say "Phase 4 — collect, ingest, store"
"$AL" collect 2>&1 | tail -1 | check "second collect copies nothing new" "0 copied"
"$AL" ingest --full 2>&1 | tail -8 | check "full rebuild reports a session count" "sessions="
"$AL" metrics 2>&1 | check "metrics re-runs the derived layers" "classifier_version="

# The source is read-only: agent-lens copies out of it and never writes back. Claude Code itself is
# usually running while this test does, so mtimes under the source churn for reasons that are not
# ours — an mtime sweep would be pure flake. Assert the thing that is actually ours instead: none of
# agent-lens's own artefacts (archive, store, lock, collect log) may appear under the source tree.
STRAY=$(find "$SOURCE_DIR" \( -name '.agent-lens*' -o -name 'agent-lens.db*' -o -name '.collect.log' -o -name 'archive' \) 2>/dev/null)
[ -z "$STRAY" ] && ok "no agent-lens artefacts written under $SOURCE_DIR" ||
  bad "agent-lens wrote into the source tree: $(echo "$STRAY" | tr '\n' ' ')"

node "$(dirname "$0")/sanity-db.mjs" "$ROOT/data/agent-lens.db" > "$ROOT/out/db.txt" 2>&1 &&
  { cat "$ROOT/out/db.txt" | sed 's/^/    /'; ok "store has rows in every core table"; } ||
  { cat "$ROOT/out/db.txt" | sed 's/^/    /'; bad "store inspection failed"; }

SID=$(curl -s "http://127.0.0.1:$PORT/api/sessions?limit=1&kind=main" |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(String(JSON.parse(s).sessions[0].id)))')
"$AL" export "$SID" --out "$ROOT/out/redacted.md" 2>&1 | check "redacted export written" "redaction: secrets"
"$AL" export "$SID" --no-redact --out "$ROOT/out/raw.md" 2>&1 | check "verbatim export written" "redaction: off"
cmp -s "$ROOT/out/redacted.md" "$ROOT/out/raw.md" && bad "redacted export is identical to verbatim" || ok "redaction changed the output"

# ---- phase 5: triage writes + web UI -------------------------------------------------------------
say "Phase 5 — triage writes and web UI"
B="http://127.0.0.1:$PORT"; O="Origin: $B"; J="Content-Type: application/json"
total() { curl -s "$B/api/security/findings?status=$1&limit=1" |
          node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(String(JSON.parse(s).total)))'; }
FID=$(curl -s "$B/api/security/findings?status=open&limit=1" |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(String(JSON.parse(s).findings[0].id)))')
OPEN_BEFORE=$(total open)
curl -s -X POST "$B/api/security/dismiss" -H "$O" -H "$J" -d "{\"ids\":[\"$FID\"]}" | check "dismiss accepted" '"dismissed":1'
[ "$(total open)" -eq "$((OPEN_BEFORE - 1))" ] && ok "open count dropped by one" || bad "open count did not drop"
[ "$(total dismissed)" -ge 1 ] && ok "finding appears as dismissed" || bad "finding is not in the dismissed view"
curl -s -X POST "$B/api/security/reopen" -H "$O" -H "$J" -d "{\"ids\":[\"$FID\"]}" | check "reopen accepted" '"reopened":1'
[ "$(total open)" -eq "$OPEN_BEFORE" ] && ok "open count restored" || bad "open count not restored after reopen"

curl -s -X PUT "$B/api/prefs/sanity.test" -H "$O" -H "$J" -d '{"value":{"n":42}}' >/dev/null
curl -s "$B/api/prefs/sanity.test" | check "UI preference round-trips" '"n":42'

curl -s -X POST "$B/api/security/dismiss" -H "Origin: http://evil.com" -H "$J" -d "{\"ids\":[\"$FID\"]}" |
  check "cross-origin write is blocked" "FORBIDDEN_ORIGIN"
curl -s "$B/api/health" -H "Host: evil.com" | check "non-loopback Host is rejected" "FORBIDDEN_HOST"
curl -s -X POST "$B/api/refresh" -H "$O" --max-time 300 | check "refresh runs collect+ingest" '"ok":true'

if node -e 'require.resolve("playwright")' 2>/dev/null; then
  node "$(dirname "$0")/sanity-pages.mjs" "$B" "$ROOT/shots" | sed 's/^/    /'
  [ "${PIPESTATUS[0]}" = 0 ] && ok "every SPA route rendered" || bad "an SPA route failed to render"
else
  echo "    SKIPPED: playwright not resolvable — run from a source checkout with dev deps installed"
fi

# ---- final safety re-check -----------------------------------------------------------------------
say "Safety re-check"
NOW_UNITS=$(sha256sum "$UNIT_DIR"/agent-lens-*.{service,timer} 2>/dev/null | grep -v "$PREFIX" | sort)
NOW_ENABLED=$(systemctl --user list-unit-files 'agent-lens*' --no-legend 2>/dev/null | grep -v "$PREFIX" | awk '{print $1, $2}' | sort)
[ "$NOW_UNITS" = "$BASE_UNITS" ] && ok "existing unit files unchanged" || bad "existing unit files CHANGED"
[ "$NOW_ENABLED" = "$BASE_ENABLED" ] && ok "existing unit enablement unchanged" || bad "existing unit enablement CHANGED"

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
exit $((FAIL > 0))
