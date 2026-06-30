#!/usr/bin/env bash
# End-to-end validation sandbox (validation Layer 5).
#
# Runs the REAL pipeline (ingest --full → server → HTTP API) over the committed corpus, in a fully
# env-isolated temp dir — never touches your real data/ or DB. The corpus carries three sources
# (team-a, team-b = redacted real; scenarios = synthetic) covering every pipeline scenario, and this
# script asserts each one end-to-end: multi-source, plain, subagents (no double-count), workflow
# fan-out (linked to orchestrator via the subagents/ path), compaction, dedup, cache tokens, and
# malformed handling.
#
# Usage: bash scripts/sandbox.sh   (requires `pnpm build` to have produced the dist/ outputs)
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
command -v node >/dev/null || { eval "$(mise activate bash 2>/dev/null)" || true; }
command -v sqlite3 >/dev/null || { echo "sandbox: sqlite3 CLI required" >&2; exit 1; }

SBX="$(mktemp -d /tmp/al-sandbox.XXXXXX)"
PORT="${AGENT_LENS_PORT:-14477}"
export AGENT_LENS_DATA="$SBX"
export AGENT_LENS_ARCHIVE="$REPO/test/fixtures/corpus"
export AGENT_LENS_DB="$SBX/sandbox.db"
export AGENT_LENS_CONFIG="$SBX/sources.json"
export AGENT_LENS_PORT="$PORT"

cat >"$AGENT_LENS_CONFIG" <<'JSON'
{ "sources": [
  { "label": "team-a",    "agent": "claude-code", "configDir": "/unused-in-ingest" },
  { "label": "team-b",    "agent": "claude-code", "configDir": "/unused-in-ingest" },
  { "label": "scenarios", "agent": "claude-code", "configDir": "/unused-in-ingest" }
] }
JSON

SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$SBX"; }
trap cleanup EXIT

fails=0
ok() { if [ "$1" = "$2" ]; then echo "  PASS  $3 ($2)"; else echo "  FAIL  $3 (got '$2', want '$1')"; fails=$((fails + 1)); fi; }
q() { sqlite3 "$AGENT_LENS_DB" "$1"; }

echo "=== ingest --full over the 3-source corpus (isolated DB) ==="
INGEST="$(node packages/ingest/dist/index.js --full)"; echo "$INGEST" | sed 's/^/  /'

echo "=== scenario assertions (DB) ==="
# malformed / partial JSONL: the truncated line was counted, not silently dropped.
ok 1 "$(echo "$INGEST" | grep -oE 'malformed=[0-9]+' | cut -d= -f2)" "malformed line counted"
# multi-source: three labeled sources, no cross-source bleed.
ok 3 "$(q "SELECT COUNT(DISTINCT source_id) FROM sessions;")" "multi-source (3 sources)"
ok 14 "$(q "SELECT COUNT(*) FROM sessions;")" "total sessions"
ok 9 "$(q "SELECT COUNT(*) FROM sessions WHERE is_sidechain=0;")" "main sessions"
# skill versioning: api-design fires 3× over 2 content-addressed versions.
ok 2 "$(q "SELECT COUNT(*) FROM skills WHERE name='api-design';")" "skill versions (content-addressed)"
ok 2 "$(q "SELECT COUNT(DISTINCT skill_id) FROM tool_calls WHERE skill_name='api-design';")" "skill firings link to a version"
# subagents: all 5 link to a parent — 3 Task (toolUseResult.agentId) + 2 workflow (run id).
ok 5 "$(q "SELECT COUNT(*) FROM sessions WHERE is_sidechain=1 AND parent_session_id IS NOT NULL;")" "linked subagents"
ok 0 "$(q "SELECT COUNT(*) FROM sessions WHERE is_sidechain=1 AND parent_session_id IS NULL;")" "no orphan subagents"
ok 2 "$(q "SELECT COUNT(*) FROM sessions WHERE parent_session_id='sc-workflow-0003';")" "workflow fan-out linked to orchestrator"
# workflow run is captured + tied to the launching turn (run grouping in the UI).
ok 2 "$(q "SELECT COUNT(*) FROM sessions WHERE workflow_run_id='wf_demo000abc' AND parent_turn_id IS NOT NULL;")" "workflow agents linked to launching turn"
ok migrate-db "$(q "SELECT workflow_name FROM tool_calls WHERE workflow_run_id='wf_demo000abc';")" "Workflow tool_call carries run name"
# no double-count: the child's tokens live in the child session, not folded into the parent.
ok 1500 "$(q "SELECT SUM(input_tokens) FROM token_usage WHERE session_id='agent-c0ffee01';")" "child tokens attributed to child"
ok 1300 "$(q "SELECT SUM(input_tokens) FROM token_usage WHERE session_id='sc-sub-parent-0002';")" "parent tokens exclude child"
# compaction: an isMeta summary line does not create a turn.
ok 2 "$(q "SELECT turn_count FROM sessions WHERE id='sc-plain-0001';")" "compaction adds no turn"
# dedup: a uuid in both mirror and .versions is stored once (e3 from the version is kept).
ok 3 "$(q "SELECT event_count FROM sessions WHERE id='sc-resumed-0005';")" "dup-uuid dedup (mirror + .versions)"
# cache tokens accounted (read and creation are tracked separately).
ok 1 "$(q "SELECT (SUM(cache_read_input_tokens)>0 AND SUM(cache_creation_input_tokens)>0) FROM token_usage;")" "cache read + creation tracked"

echo "=== API assertions (server) ==="
node packages/server/dist/index.js &
SERVER_PID=$!
for i in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 0.1; done
OV="$(curl -sf "http://127.0.0.1:$PORT/api/dashboard/overview")"
BD="$(curl -sf "http://127.0.0.1:$PORT/api/dashboard/breakdowns")"
SK="$(curl -sf "http://127.0.0.1:$PORT/api/skills")"
SKD="$(curl -sf "http://127.0.0.1:$PORT/api/skills/api-design")"
node -e '
  const ov = JSON.parse(process.argv[1]), bd = JSON.parse(process.argv[2]);
  const sk = JSON.parse(process.argv[3]), skd = JSON.parse(process.argv[4]);
  let bad = 0; const ok = (c, n) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${n}`); if (!c) bad++; };
  ok(ov.sessions === 14, "overview serves 14 sessions");
  ok(bd.by_source.length === 3, "breakdowns: 3 sources");
  ok(ov.cost > 0 && ov.tokens.cache_read > 0, "overview: cost + cache_read > 0");
  ok(bd.subagent_fanout.total_spawns >= 1, "breakdowns: subagent fan-out present");
  ok(bd.skill_versions.length === 2, "breakdowns: skill versions present");
  ok(sk.length === 1 && sk[0].name === "api-design" && sk[0].version_count === 2, "skills list: api-design with 2 versions");
  ok(skd.versions.length === 2 && skd.versions.every(v => v.body && v.summary === "API Design"), "skill detail: 2 versions with bodies");
  process.exit(bad ? 1 : 0);
' "$OV" "$BD" "$SK" "$SKD" || fails=$((fails + 1))

echo
[ "$fails" -eq 0 ] && { echo "=== sandbox e2e PASS (all scenarios) ==="; } || { echo "=== sandbox e2e FAILED: $fails check(s) ==="; exit 1; }
