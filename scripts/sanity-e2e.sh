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
#
# Feed it with a HERESTRING, never a pipe. `cmd | check ...` runs check in a subshell, so its PASS/FAIL
# increments are discarded when that subshell exits — the run then prints a red FAIL and still reports
# "0 failed" and exits 0, which is worse than no gate at all.
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

# ---- install -------------------------------------------------------------------------------------
say "Install from npm"
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
check "CLI reports a version" "agent-lens/" <<< "$("$AL" --version)"
"$AL" --help > "$ROOT/out/help.txt" 2>&1
grep -c '^  [a-z]' "$ROOT/out/help.txt" >/dev/null && ok "--help lists commands"

# A bare install must resolve to the per-user OS data dir, not a repo path.
BARE_CONFIG=$(env -i HOME="$HOME" PATH="$(dirname "$(command -v node)"):/usr/bin:/bin" "$AL" config 2>&1)
check "bare install defaults to the per-user data dir" "$HOME" <<< "$(grep '^  data dir' <<< "$BARE_CONFIG")"

# ---- config isolation ---------------------------------------------------------------------------
say "Config resolution"
"$AL" config > "$ROOT/out/config.txt" 2>&1
check "data dir is isolated"  "$ROOT/data" <<< "$(grep '^  data dir'  "$ROOT/out/config.txt")"
check "db is isolated"        "$ROOT/data" <<< "$(grep '^  db '       "$ROOT/out/config.txt")"
check "triage db is isolated" "$ROOT/data" <<< "$(grep '^  triage db' "$ROOT/out/config.txt")"
check "port is overridden"    "$PORT" <<< "$(grep '^  port'      "$ROOT/out/config.txt")"

# ---- user-facing error handling -----------------------------------------------------------------
# Bad input must read as one line, not a Node stack trace. Asserting the absence of a stack frame is
# the real check — the messages were always fine, it was the boundary that was missing.
say "Error handling"
STACK_RE='^[[:space:]]+at '
errcase() { # errcase <description> <expected-substring> -- <argv...>
  local desc="$1" want="$2"; shift 3
  local out status
  out=$("$AL" "$@" 2>&1); status=$?
  if [ "$status" -ne 1 ]; then bad "$desc: exited $status, wanted 1"; return; fi
  case "$out" in
    *"$want"*) ;;
    *) bad "$desc: wanted '$want', got: $(echo "$out" | head -1)"; return ;;
  esac
  if echo "$out" | grep -qE "$STACK_RE"; then bad "$desc: printed a stack trace"; return; fi
  case "$out" in "agent-lens: "*) ok "$desc" ;; *) bad "$desc: missing the 'agent-lens:' prefix" ;; esac
}
errcase "rejects an unknown service target" "invalid target" -- service install nonsense
errcase "rejects a malformed --times"       "invalid hours"  -- service install --times abc

# A config file that parses but configures nothing — the likeliest first-run failure.
echo '{ "sources": [] }' > "$ROOT/empty.json"
AGENT_LENS_CONFIG="$ROOT/empty.json" errcase "rejects an empty sources list" "no valid sources" -- collect

# ---- unit generation, live systemd untouched ----------------------------------------------------
say "Unit generation — service install (shimmed systemctl, redirected XDG_CONFIG_HOME)"
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
check "timer honours --times"        "08,20:00" <<< "$(cat "$GEN/agent-lens-collect.timer"    2>/dev/null)"
check "collector bakes an absolute node path" "ExecStart=/" <<< "$(grep '^ExecStart=' "$GEN/agent-lens-collect.service" 2>/dev/null)"
check "server unit bakes the port"    "AGENT_LENS_PORT=$PORT" <<< "$(cat "$GEN/agent-lens-server.service"   2>/dev/null)"
check "install enables the timer"     "enable --now agent-lens-collect.timer" <<< "$(cat "$ROOT/systemctl.log"              2>/dev/null)"
# The path env must reach BOTH units — a scheduler inherits none of this shell's environment, and
# the collector is the one that writes the archive. The renamed units below rely on this.
check "collector bakes the data dir"  "AGENT_LENS_DATA=$ROOT/data" <<< "$(cat "$GEN/agent-lens-collect.service"  2>/dev/null)"
check "collector bakes the config"    "AGENT_LENS_CONFIG=$ROOT/agent-lens.config.json" <<< "$(cat "$GEN/agent-lens-collect.service"  2>/dev/null)"
check "server bakes the data dir"     "AGENT_LENS_DATA=$ROOT/data" <<< "$(cat "$GEN/agent-lens-server.service"   2>/dev/null)"
NOW_UNITS=$(sha256sum "$UNIT_DIR"/agent-lens-*.{service,timer} 2>/dev/null | grep -v "$PREFIX" | sort)
[ "$NOW_UNITS" = "$BASE_UNITS" ] && ok "existing units untouched by service install" || bad "service install modified existing units"

# ---- real systemd run under renamed units -------------------------------------------------------
say "Run under systemd as $PREFIX-*"
# Rename only. The units are otherwise byte-for-byte what `service install` produced — including the
# isolation env, which they now carry themselves. Until 0.13.1 this step had to inject the
# Environment= lines by hand, because `service install` baked only port/host and the units would
# have collected into the real data dir; that workaround is what made the bug visible.
sed -e "s|^Description=|Description=[SANITY TEST] |" \
    "$GEN/agent-lens-collect.service" > "$UNIT_DIR/$PREFIX-collect.service"
sed -e "s|^Description=|Description=[SANITY TEST] |" -e "/^\[Timer\]/a Unit=$PREFIX-collect.service" \
    "$GEN/agent-lens-collect.timer" > "$UNIT_DIR/$PREFIX-collect.timer"
sed -e "s|^Description=|Description=[SANITY TEST] |" \
    "$GEN/agent-lens-server.service" > "$UNIT_DIR/$PREFIX-server.service"
systemctl --user daemon-reload

# Belt and braces: if the units somehow lost the isolation env, the collector would mirror the real
# Claude install into the real data dir. Refuse to start rather than find out afterwards.
grep -q "AGENT_LENS_DATA=$ROOT/data" "$UNIT_DIR/$PREFIX-collect.service" ||
  { bad "renamed collector unit lost the isolated data dir — refusing to run it"; exit 1; }

# The oneshot collector runs the whole collect+ingest pipeline; drive it directly rather than
# waiting for the clock.
systemctl --user start "$PREFIX-collect.service"
check "collector unit succeeded" "success" <<< "$(systemctl --user show "$PREFIX-collect.service" -p Result --value)"
journalctl --user -u "$PREFIX-collect.service" --no-pager -n 40 > "$ROOT/out/collect-journal.txt" 2>&1
grep -c "collect done" "$ROOT/out/collect-journal.txt" >/dev/null && ok "collector logged a collect summary" || bad "no collect summary in the journal"

systemctl --user start "$PREFIX-server.service"; sleep 3
check "server unit is active" "active" <<< "$(systemctl --user is-active "$PREFIX-server.service")"
check "health responds on $PORT" '"ok":true' <<< "$(curl -s --max-time 10 "http://127.0.0.1:$PORT/api/health")"

# Restart=always is the unit's stated contract — prove it rather than trusting the directive.
OLDPID=$(systemctl --user show "$PREFIX-server.service" -p MainPID --value)
kill -TERM "$OLDPID" 2>/dev/null; sleep 8
NEWPID=$(systemctl --user show "$PREFIX-server.service" -p MainPID --value)
[ -n "$NEWPID" ] && [ "$NEWPID" != "0" ] && [ "$NEWPID" != "$OLDPID" ] &&
  ok "Restart=always brought the server back ($OLDPID → $NEWPID)" || bad "server did not restart after SIGTERM"

systemctl --user enable --now "$PREFIX-collect.timer" >/dev/null 2>&1
check "timer is scheduled" "$PREFIX-collect.timer" <<< "$(systemctl --user list-timers "$PREFIX-collect.timer" --no-pager)"

# ---- collect / ingest / store -------------------------------------------------------------------
say "Collect, ingest, store"
# Incremental collect: a second pass must recognise what it already has. Deliberately NOT "0 copied"
# — Claude Code is usually running while this is, so genuinely new transcripts appear mid-run and a
# zero would be flaky. The property that matters is that it doesn't re-copy the archive wholesale.
RECOLLECT=$("$AL" collect 2>&1 | tail -1)
SCANNED=$(sed -n 's/.*— [0-9]* source(s), \([0-9]*\) scanned.*/\1/p' <<< "$RECOLLECT")
COPIED=$(sed -n 's/.*scanned, \([0-9]*\) copied.*/\1/p' <<< "$RECOLLECT")
if [ -n "$SCANNED" ] && [ -n "$COPIED" ] && [ "$SCANNED" -gt 0 ] && [ "$COPIED" -lt "$SCANNED" ]; then
  ok "second collect is incremental ($COPIED newly copied of $SCANNED scanned)"
else
  bad "second collect re-copied the archive: $RECOLLECT"
fi
check "full rebuild reports a session count" "sessions=" <<< "$("$AL" ingest --full 2>&1 | tail -8)"
check "metrics re-runs the derived layers" "classifier_version=" <<< "$("$AL" metrics 2>&1)"

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
check "redacted export written" "redaction: secrets" <<< "$("$AL" export "$SID" --out "$ROOT/out/redacted.md" 2>&1)"
check "verbatim export written" "redaction: off" <<< "$("$AL" export "$SID" --no-redact --out "$ROOT/out/raw.md" 2>&1)"
cmp -s "$ROOT/out/redacted.md" "$ROOT/out/raw.md" && bad "redacted export is identical to verbatim" || ok "redaction changed the output"

# ---- triage writes + web UI ---------------------------------------------------------------------
say "Triage writes and web UI"
B="http://127.0.0.1:$PORT"; O="Origin: $B"; J="Content-Type: application/json"
total() { curl -s "$B/api/security/findings?status=$1&limit=1" |
          node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(String(JSON.parse(s).total)))'; }
FID=$(curl -s "$B/api/security/findings?status=open&limit=1" |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(String(JSON.parse(s).findings[0].id)))')
OPEN_BEFORE=$(total open)
check "dismiss accepted" '"dismissed":1' <<< "$(curl -s -X POST "$B/api/security/dismiss" -H "$O" -H "$J" -d "{\"ids\":[\"$FID\"]}")"
[ "$(total open)" -eq "$((OPEN_BEFORE - 1))" ] && ok "open count dropped by one" || bad "open count did not drop"
[ "$(total dismissed)" -ge 1 ] && ok "finding appears as dismissed" || bad "finding is not in the dismissed view"
check "reopen accepted" '"reopened":1' <<< "$(curl -s -X POST "$B/api/security/reopen" -H "$O" -H "$J" -d "{\"ids\":[\"$FID\"]}")"
[ "$(total open)" -eq "$OPEN_BEFORE" ] && ok "open count restored" || bad "open count not restored after reopen"

curl -s -X PUT "$B/api/prefs/sanity.test" -H "$O" -H "$J" -d '{"value":{"n":42}}' >/dev/null
check "UI preference round-trips" '"n":42' <<< "$(curl -s "$B/api/prefs/sanity.test")"

curl -s -X POST "$B/api/security/dismiss" -H "Origin: http://evil.com" -H "$J" -d "{\"ids\":[\"$FID\"]}" |
  check "cross-origin write is blocked" "FORBIDDEN_ORIGIN"
check "non-loopback Host is rejected" "FORBIDDEN_HOST" <<< "$(curl -s "$B/api/health" -H "Host: evil.com")"
check "refresh runs collect+ingest" '"ok":true' <<< "$(curl -s -X POST "$B/api/refresh" -H "$O" --max-time 300)"

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
