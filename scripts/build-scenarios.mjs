#!/usr/bin/env node
/**
 * Generate the synthetic "scenarios" corpus source (validation Layer 4/5). Unlike the redacted real
 * sources (team-a/team-b, which prove the redaction oracle), these are hand-authored, contain NO real
 * data, and use readable fake content — so they (a) represent every pipeline scenario end-to-end in
 * the sandbox and (b) make decent demo screenshots. Committed output; re-runnable & deterministic.
 *
 * Scenarios covered (one source = three claude configs once team-a/team-b are added → multi-source):
 *   plain · subagents (Task, no double-count) · workflow fan-out (linked via subagents/ path) · compaction/meta
 *   · cache tokens · dup-uuid across mirror + .versions (dedup) · malformed/partial JSONL
 *
 * Output: test/fixtures/corpus/scenarios/{projects,.versions}/-demo-acme-api/…
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "test/fixtures/corpus/scenarios");
const PROJ = "-demo-acme-api";
const CWD = "/demo/acme-api";
const OPUS = "claude-opus-4-8";
const HAIKU = "claude-haiku-4-5-20251001";
const ts = (s) => `2026-03-10T12:${String(s).padStart(2, "0")}:00.000Z`;
const u = (id, extra) => ({ uuid: id, ...extra });
const asst = (id, t, model, content, usage) => u(id, { type: "assistant", timestamp: ts(t), message: { role: "assistant", id: `msg_${id}`, model, content, usage } });
const usage = (i, o, cw, cr) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: cw, cache_read_input_tokens: cr });
const userMsg = (id, t, text, extra = {}) => u(id, { type: "user", timestamp: ts(t), cwd: CWD, gitBranch: "main", version: "2.1.0", message: { role: "user", content: text }, ...extra });
const toolResult = (id, t, tuid, extra = {}) => u(id, { type: "user", timestamp: ts(t), message: { role: "user", content: [{ type: "tool_result", tool_use_id: tuid, content: "(result)" }] }, ...extra });
const toolResText = (id, t, tuid, text, extra = {}) => u(id, { type: "user", timestamp: ts(t), message: { role: "user", content: [{ type: "tool_result", tool_use_id: tuid, content: text }] }, ...extra });
const SONNET = "claude-sonnet-4-5";
const FABLE = "claude-fable-5";
// Wide demo time span: new sessions are dated across Jan–Mar 2026 (the validation scenarios above sit
// at 2026-03-10), so the dashboard time-series has real range. Date is available in this plain node
// script (unlike the workflow sandbox).
const iso = (date, hh = 10, mm = 0) => `${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000Z`;
const addMin = (isoStr, m) => new Date(Date.parse(isoStr) + m * 60000).toISOString();

/**
 * Compact factory for a rich, readable multi-turn demo session. `turns` is a list of
 * { ask, say?, tools?: [{ name, input, result?, extra? }], usage, model?, branch? }. Timestamps step
 * forward from `startIso`; tokens come from each turn's `usage` (use big cache-read values for weight).
 * Emits the assistant text + tool_use blocks and the matching tool_result events, so every session
 * browses as a real conversation — no "[redacted]", no real data.
 */
function richSession(id, proj, cwd, model, startIso, turns, gapMin = 0) {
  const lines = [];
  let clock = startIso;
  const tick = (m) => { const t = clock; clock = addMin(clock, m); return t; };
  let ti = 0;
  for (const turn of turns) {
    lines.push(u(`${id}-u${ti}`, { type: "user", timestamp: tick(1), cwd, gitBranch: turn.branch || "main", version: "2.1.0", message: { role: "user", content: turn.ask } }));
    const content = [];
    if (turn.say) content.push({ type: "text", text: turn.say });
    const results = [];
    (turn.tools || []).forEach((tool, k) => {
      const tuid = `${id}-t${ti}-${k}`;
      content.push({ type: "tool_use", id: tuid, name: tool.name, input: tool.input });
      results.push({ tuid, result: tool.result ?? "(result)", extra: tool.extra });
    });
    lines.push(u(`${id}-a${ti}`, { type: "assistant", timestamp: tick(2), message: { role: "assistant", id: `msg_${id}_${ti}`, model: turn.model || model, content, usage: turn.usage } }));
    for (const r of results) lines.push(u(`${id}-r${ti}-${r.tuid}`, { type: "user", timestamp: tick(1), message: { role: "user", content: [{ type: "tool_result", tool_use_id: r.tuid, content: r.result }] }, ...(r.extra ? { toolUseResult: r.extra } : {}) }));
    clock = addMin(clock, gapMin); // widen inter-turn gap so long sessions read as long-running
    ti++;
  }
  write(`projects/${proj}/${id}.jsonl`, lines);
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);
/** A large, long-running session (many turns editing many modules, big work-token usage, optional
 * subagent) — engineered to land in the higher complexity bands so the dashboard's Complexity chart
 * spreads across trivial→xl instead of pegging trivial. Content is templated but readable. */
function bigSession(id, proj, cwd, model, startIso, { intro, modules, tokenScale = 1, gapMin = 8, sub = null }) {
  // Realistic token shape: modest cache *writes*, large cache *reads* (cheap, high-volume replays) —
  // tokenScale drives the reads, so totals get big without an unbelievable cost.
  const T = [{ ask: intro, say: `Working through ${modules.length} modules end to end.`, usage: usage(4000, 1600, 12000, Math.round(90000 * tokenScale)) }];
  modules.forEach((m, i) => T.push({
    ask: `Now handle the ${m} module`,
    say: `Updating \`${m}\` — validating input, wiring metrics, and dropping the legacy path.`,
    tools: [
      { name: "Read", input: { file_path: `src/${m}.ts` }, result: `export function ${m}(input) {\n  // legacy path\n  const r = legacy(input);\n  return r;\n}` },
      { name: "Edit", input: { file_path: `src/${m}.ts`, old_string: `export function ${m}(input) {\n  // legacy path\n  const r = legacy(input);\n  return r;\n}`, new_string: `export function ${m}(input: ${cap(m)}Input): ${cap(m)}Result {\n  const v = ${m}Schema.parse(input);\n  const r = pipeline(v);\n  metrics.record('${m}', r.status);\n  return r;\n}` }, result: `The file src/${m}.ts has been updated.` },
    ],
    usage: usage(3200, 1300, 9000, Math.round((160000 + i * 8000) * tokenScale)),
  }));
  if (sub) T.push({ ask: "Delegate the cross-module audit", say: "Spawning an auditor to check the seams in parallel.", tools: [{ name: "Task", input: { subagent_type: "general-purpose", description: sub.desc, prompt: sub.prompt }, result: "Audit complete — no cross-module regressions.", extra: { status: "completed", agentId: sub.agentId, agentType: "general-purpose", totalTokens: 6200, totalDurationMs: 140000, totalToolUseCount: 9 } }], usage: usage(2600, 900, 8000, Math.round(180000 * tokenScale)) });
  T.push({ ask: "Run the full suite and confirm", tools: [{ name: "Bash", input: { command: "pnpm -r build && pnpm test", description: "Build all packages and run the full test suite" }, result: ` Test Files  ${modules.length + 22} passed (${modules.length + 22})\n      Tests  ${modules.length * 12} passed (${modules.length * 12})\n   Duration  ${(9 + modules.length * 0.4).toFixed(1)}s` }], usage: usage(2200, 600, 6000, Math.round(240000 * tokenScale)) });
  richSession(id, proj, cwd, model, startIso, T, gapMin);
}

function write(relPath, lines) {
  const dest = join(ROOT, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
}

rmSync(ROOT, { recursive: true, force: true });

// 1) PLAIN + COMPACTION + CACHE: 2 prompts (turn0, turn1); an isMeta compaction line starts no turn;
//    cache-read grows across turns (cache-token accounting).
write(`projects/${PROJ}/sc-plain-0001.jsonl`, [
  userMsg("p1", 1, "Add pagination to the users API endpoint"),
  asst("p2", 2, OPUS, [{ type: "text", text: "I'll add limit/offset pagination." }, { type: "tool_use", id: "tu_p2", name: "Read", input: { file_path: `${CWD}/users.py` } }], usage(1200, 300, 800, 5000)),
  toolResult("p3", 3, "tu_p2"),
  asst("p4", 4, OPUS, [{ type: "tool_use", id: "tu_p4", name: "Edit", input: { file_path: `${CWD}/users.py`, old_string: "def list_users():\n    return all()", new_string: "def list_users(limit, offset):\n    return page(limit, offset)\n    # paginated" } }], usage(900, 150, 0, 8000)),
  toolResult("p5", 5, "tu_p4"),
  asst("p6", 6, OPUS, [{ type: "text", text: "Done — pagination added." }], usage(500, 80, 0, 9000)),
  userMsg("p7", 7, "[Context compacted: summary of the session so far]", { isMeta: true }),
  userMsg("p8", 8, "Now add sorting by name too"),
  asst("p9", 9, OPUS, [{ type: "text", text: "Added sorting." }], usage(400, 60, 0, 9500)),
]);

// 2) SUBAGENTS (Task-spawned): the parent spawns a general-purpose agent; the child's tokens live in
//    the CHILD session only (no double-count), and the child links back to the parent turn.
write(`projects/${PROJ}/sc-sub-parent-0002.jsonl`, [
  userMsg("b1", 1, "Investigate the failing auth test"),
  asst("b2", 2, OPUS, [{ type: "tool_use", id: "tu_task", name: "Task", input: { subagent_type: "general-purpose", prompt: "find the bug" } }], usage(600, 120, 0, 2000)),
  toolResult("b3", 5, "tu_task", { toolUseResult: { status: "completed", agentId: "c0ffee01", agentType: "general-purpose", totalTokens: 3400, totalDurationMs: 8000, totalToolUseCount: 5 } }),
  asst("b4", 6, OPUS, [{ type: "text", text: "Fixed based on the finding." }], usage(700, 200, 0, 3000)),
]);
write(`projects/${PROJ}/sc-sub-parent-0002/subagents/agent-c0ffee01.jsonl`, [
  u("c1", { type: "user", timestamp: ts(3), isSidechain: true, agentId: "c0ffee01", cwd: CWD, message: { role: "user", content: "find the bug" } }),
  u("c2", { type: "assistant", timestamp: ts(4), isSidechain: true, agentId: "c0ffee01", message: { role: "assistant", id: "msg_c2", model: HAIKU, content: [{ type: "text", text: "The bug is a missing null check." }], usage: usage(1500, 250, 0, 0) } }),
]);

// 3) WORKFLOW FAN-OUT: an orchestrator invokes the Workflow tool; the tool spawns its agents and
//    records them in a per-run `journal.jsonl`, NOT via a Task/Agent toolUseResult.agentId. The agent
//    transcripts nest under <parent>/subagents/workflows/wf_<runId>/ (the real on-disk layout). They
//    link to the orchestrator via that directory structure (parent_session_id = sc-workflow-0003);
//    parent_turn_id stays NULL (the journal records no spawning turn). Each agent's tokens live in its
//    own session and do not roll up — so attribution is complete without double-counting.
const WF_RUN = "wf_demo000abc"; // synthetic runId; the journal + agents sit under this run dir
write(`projects/${PROJ}/sc-workflow-0003.jsonl`, [
  userMsg("w1", 1, "Run the full DB migration workflow"),
  asst("w2", 2, OPUS, [{ type: "tool_use", id: "tu_wf", name: "Workflow", input: { name: "migrate" } }], usage(800, 100, 0, 1000)),
  // The Workflow result carries the run id + name (no per-agent agentId): this ties the run — and its
  // fan-out under subagents/workflows/<runId>/ — back to THIS turn so the UI can group + link them.
  toolResult("w3", 9, "tu_wf", { toolUseResult: { status: "async_launched", runId: WF_RUN, workflowName: "migrate-db" } }),
  asst("w4", 10, OPUS, [{ type: "text", text: "Migration complete." }], usage(300, 50, 0, 2000)),
]);
// The workflow's journal: started/result markers per spawned agent (no uuid → no events → pruned as a
// phantom session; present so the corpus represents the real on-disk artifact).
const WF_DIR = `projects/${PROJ}/sc-workflow-0003/subagents/workflows/${WF_RUN}`;
write(`${WF_DIR}/journal.jsonl`, [
  { type: "started", agentId: "wf01", key: "migrate:users" },
  { type: "result", agentId: "wf01", key: "migrate:users", result: "ok" },
  { type: "started", agentId: "wf02", key: "migrate:orders" },
  { type: "result", agentId: "wf02", key: "migrate:orders", result: "ok" },
]);
for (const [n, table, i, o] of [["wf01", "users", 1000, 120], ["wf02", "orders", 1100, 130]]) {
  write(`${WF_DIR}/agent-${n}.jsonl`, [
    u(`${n}a`, { type: "user", timestamp: ts(3), isSidechain: true, agentId: n, cwd: CWD, message: { role: "user", content: `migrate table ${table}` } }),
    u(`${n}b`, { type: "assistant", timestamp: ts(4), isSidechain: true, agentId: n, message: { role: "assistant", id: `msg_${n}`, model: HAIKU, content: [{ type: "text", text: `migrated ${table}` }], usage: usage(i, o, 0, 0) } }),
  ]);
}

// 3a-i) WORKFLOW RESULT SIDECAR (workflows/wf_<id>.json): the authoritative record of how the run
//     finished — status/summary, phase structure, live progress events, per-item logs, the returned
//     result payload, and roll-up tokens/tool-calls/agents. Drives the workflow detail page + phase
//     graph (progress_json ← workflowProgress, phases_json ← phases). Lives beside (not under) the
//     fan-out: <session>/workflows/<runId>.json.
write(`projects/${PROJ}/sc-workflow-0003/workflows/${WF_RUN}.json`, [
  {
    runId: WF_RUN,
    taskId: "tu_wf",
    workflowName: "migrate-db",
    status: "completed",
    summary: "Migrated the users and orders tables across two fan-out agents; row counts verified.",
    defaultModel: HAIKU,
    startTime: 1789041720000,
    durationMs: 42000,
    agentCount: 2,
    totalTokens: 2350,
    totalToolCalls: 8,
    phases: [{ title: "Plan" }, { title: "Migrate" }, { title: "Verify" }],
    workflowProgress: [
      { type: "workflow_phase", index: 0, title: "Plan" },
      { type: "workflow_phase", index: 1, title: "Migrate" },
      { type: "workflow_phase", index: 2, title: "Verify" },
    ],
    logs: ["users: migrated 1,204 rows", "orders: migrated 3,981 rows", "verify: row counts match source"],
    result: { migrated: [{ table: "users", rows: 1204 }, { table: "orders", rows: 3981 }], ok: true },
  },
]);
// 3a-ii) SUBAGENT META SIDECARS (subagents/agent-<id>.meta.json): the authoritative agentType /
//     description / spawnDepth for each subagent, joined onto the session at read time (type +
//     description badges). One per fan-out agent, plus the Task-spawned child in scenario 2.
write(`${WF_DIR}/agent-wf01.meta.json`, [{ agentType: "migrator", description: "Migrate the users table", toolUseId: "tu_wf", spawnDepth: 1 }]);
write(`${WF_DIR}/agent-wf02.meta.json`, [{ agentType: "migrator", description: "Migrate the orders table", toolUseId: "tu_wf", spawnDepth: 1 }]);
write(`projects/${PROJ}/sc-sub-parent-0002/subagents/agent-c0ffee01.meta.json`, [{ agentType: "general-purpose", description: "Investigate the failing auth test", toolUseId: "tu_task" }]);

// 3b) SLASH COMMAND: a local slash command (/plugin) — a markup-wrapped invocation plus its local
//     stdout, with NO assistant output (local commands never reach the model). Exercises the command
//     chip rendering and the "user messages, no output" shape.
write(`projects/${PROJ}/sc-command-0006.jsonl`, [
  u("cmd0", { type: "user", timestamp: ts(1), cwd: CWD, isMeta: true, message: { role: "user", content: "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages.</local-command-caveat>" } }),
  u("cmd1", { type: "user", timestamp: ts(2), cwd: CWD, message: { role: "user", content: "<command-name>/plugin</command-name>\n<command-message>plugin</command-message>\n<command-args></command-args>" } }),
  u("cmd2", { type: "user", timestamp: ts(3), cwd: CWD, message: { role: "user", content: "<local-command-stdout>(no content)</local-command-stdout>" } }),
]);

// 3c) SKILL VERSIONING: a skill fires three times. Each firing injects the SKILL.md body as an isMeta
//     user event ("Base directory for this skill: …\n\n<body>\n\nARGUMENTS: …"). Firings 1+2 share the
//     same body (→ one content-addressed version); firing 3 has changed content (→ a second version).
//     Exercises the skills list, the per-version skill page, the session→version link, and the
//     dashboard's grouped (versions-on-hover) skill bar. Bodies are hand-authored — no real data.
const skillInject = (id, t, body, args) =>
  u(id, { type: "user", timestamp: ts(t), isMeta: true, message: { role: "user", content: `Base directory for this skill: /demo/skills/api-design\n\n${body}\n\nARGUMENTS: ${args}` } });
const SKILL_V1 = "# API Design\n\nDesign RESTful endpoints: pick nouns, return correct status codes, and paginate list responses.";
const SKILL_V2 = "# API Design\n\nDesign RESTful and GraphQL endpoints: pick nouns, return correct status codes, paginate list responses, and version the contract.";
const skillFire = (a, t, tuid, args) => asst(a, t, OPUS, [{ type: "tool_use", id: tuid, name: "Skill", input: { skill: "api-design", args } }], usage(300, 40, 0, 1000));
write(`projects/${PROJ}/sc-skill-0007.jsonl`, [
  userMsg("k1", 1, "Design the orders API"),
  skillFire("k2", 2, "tu_sk1", "design orders endpoint"),
  toolResult("k3", 3, "tu_sk1"),
  skillInject("k4", 4, SKILL_V1, "design orders endpoint"),
  userMsg("k5", 5, "Now design the invoices API the same way"),
  skillFire("k6", 6, "tu_sk2", "design invoices endpoint"),
  skillInject("k7", 7, SKILL_V1, "design invoices endpoint"), // same body → same version as the first firing
  userMsg("k8", 8, "Re-run with the updated skill"),
  skillFire("k9", 9, "tu_sk3", "design payments endpoint"),
  skillInject("k10", 10, SKILL_V2, "design payments endpoint"), // changed body → a second version
  asst("k11", 11, OPUS, [{ type: "text", text: "Designed all three endpoints." }], usage(400, 90, 0, 2000)),
]);

// 4) MALFORMED / PARTIAL JSONL: a truncated line is counted as malformed, the valid lines still ingest.
write(`projects/${PROJ}/sc-malformed-0004.jsonl`, [
  userMsg("m1", 1, "Quick question about the config"),
  "{ this line is truncated and not valid json",
  asst("m2", 2, OPUS, [{ type: "text", text: "Here's the answer." }], usage(200, 40, 0, 500)),
]);

// 5) DUP-UUID / RESUMED: the same session appears in the mirror AND a .versions snapshot; the shared
//    uuids dedup (ON CONFLICT DO NOTHING) and the version-only appended event (e3) is kept once.
const resumedMirror = [
  userMsg("e1", 1, "Resume the refactor from yesterday"),
  asst("e2", 2, OPUS, [{ type: "text", text: "Continuing the refactor." }], usage(300, 50, 0, 1000)),
];
write(`projects/${PROJ}/sc-resumed-0005.jsonl`, resumedMirror);
write(`.versions/20260301T000000/projects/${PROJ}/sc-resumed-0005.jsonl`, [
  ...resumedMirror,
  asst("e3", 3, OPUS, [{ type: "text", text: "Finished the refactor." }], usage(100, 20, 0, 1100)),
]);

// 6) BASH CONSOLE: shows the shell-console transcript renderer — a $ prompt per logical command
//    (heredoc-, quote-, and $()-aware so continuations aren't mis-prompted), the description as a #
//    caption, background/timeout badges, multi-line output, and a spilled full result ("Show full
//    result"). The build's real output is too large for the transcript, so it only keeps the
//    "saved to …/tool-results/<name>.txt" marker; the un-truncated text lives in the spill file below.
write(`projects/${PROJ}/sc-bash-0008.jsonl`, [
  userMsg("h1", 1, "Build, run the tests, write the deploy script, then commit and open the PR"),
  asst("h2", 2, OPUS, [
    { type: "text", text: "Building and running the suite." },
    { type: "tool_use", id: "tu_h2", name: "Bash", input: { command: "pnpm -r build && pnpm test", description: "Build all packages and run the test suite" } },
  ], usage(700, 120, 0, 3000)),
  toolResText("h3", 3, "tu_h2", `Output too large (18.4 KB). Full output saved to: ${CWD}/tool-results/bkbuild01.txt`),
  asst("h4", 4, OPUS, [
    { type: "tool_use", id: "tu_h4", name: "Bash", input: { command: "cat > deploy.sh <<'EOF'\n#!/usr/bin/env bash\nset -euo pipefail\nfor svc in api web worker; do\n  echo \"deploying $svc\"\n  kubectl rollout restart deploy/$svc\ndone\nEOF\nchmod +x deploy.sh", description: "Write a multi-service deploy script and make it executable" } },
  ], usage(400, 90, 0, 3200)),
  toolResText("h5", 5, "tu_h4", "(no output)"),
  asst("h6", 6, OPUS, [
    { type: "tool_use", id: "tu_h6", name: "Bash", input: { command: "tail -f deploy.log | grep --line-buffered ERROR > errors.txt & echo watching", description: "Watch the deploy log for errors in the background", run_in_background: true, timeout: 120000 } },
  ], usage(300, 60, 0, 3300)),
  toolResText("h7", 7, "tu_h6", "watching\n[1] 48213"),
  asst("h8", 8, OPUS, [
    { type: "tool_use", id: "tu_h8", name: "Bash", input: { command: "git add -A\ngit commit -q -m \"$(cat <<'EOF'\nrelease: cut v0.4.0\n\n- ship the shell-console + diff transcript renderers\n- preserve newlines in tool-result summaries\nEOF\n)\"\ngit push 2>&1 | tail -2\necho \"=== PR ===\"; gh pr view --json url --jq .url", description: "Commit, push, and print the PR url" } },
  ], usage(500, 110, 0, 3500)),
  toolResText("h9", 9, "tu_h8", "To github.com:demo/acme-api.git\n   9f3a1c2..7b21e04  main -> main\n=== PR ===\nhttps://github.com/demo/acme-api/pull/42"),
  asst("h10", 10, OPUS, [{ type: "text", text: "Build passed, deploy script written, watcher running, PR opened." }], usage(300, 70, 0, 3700)),
]);
// Spilled full output for the build step (the transcript kept only the "saved to" marker above).
write(`projects/${PROJ}/sc-bash-0008/tool-results/bkbuild01.txt`, [
  "> @agent-lens/core build\n> @agent-lens/ingest build\n> @agent-lens/server build\n> @agent-lens/web build\n\n42 packages built in 12.4s\n\n RUN  v4.1.9\n Test Files  16 passed (16)\n      Tests  149 passed (149)\n   Duration  2.10s",
]);

// 7) EDIT / MULTIEDIT / WRITE: the colored-diff transcript renderer — an Edit with surrounding context
//    (LCS diff, not a raw replace), a MultiEdit with two hunks, and a Write shown as all-additions.
write(`projects/${PROJ}/sc-edit-0009.jsonl`, [
  userMsg("d1", 1, "Type the greeter, tweak the config, and add a logger module"),
  asst("d2", 2, OPUS, [
    { type: "text", text: "Refactoring the greeter." },
    { type: "tool_use", id: "tu_d2", name: "Edit", input: { file_path: `${CWD}/src/greet.ts`, old_string: "export function greet(name) {\n  console.log('hi ' + name);\n  return name;\n}", new_string: "export function greet(name: string) {\n  logger.info(`hi ${name}`);\n  return name;\n}" } },
  ], usage(600, 120, 0, 4000)),
  toolResText("d3", 3, "tu_d2", "The file src/greet.ts has been updated."),
  asst("d4", 4, OPUS, [
    { type: "tool_use", id: "tu_d4", name: "MultiEdit", input: { file_path: `${CWD}/config/app.yaml`, edits: [
      { old_string: "timeout: 30\nretries: 1", new_string: "timeout: 60\nretries: 3" },
      { old_string: "log_level: info", new_string: "log_level: debug\nlog_format: json" },
    ] } },
  ], usage(400, 90, 0, 4200)),
  toolResText("d5", 5, "tu_d4", "Applied 2 edits to config/app.yaml"),
  asst("d6", 6, OPUS, [
    { type: "tool_use", id: "tu_d6", name: "Write", input: { file_path: `${CWD}/src/logger.ts`, content: "export const logger = {\n  info: (m: string) => console.log('[info]', m),\n  warn: (m: string) => console.warn('[warn]', m),\n};" } },
  ], usage(500, 100, 0, 4400)),
  toolResText("d7", 7, "tu_d6", "File created successfully at: src/logger.ts"),
  asst("d8", 8, OPUS, [{ type: "text", text: "Greeter typed, config tuned, logger added." }], usage(300, 70, 0, 4600)),
]);

// 8) PLAN + ASK-USER-QUESTION: the approved-plan card (ExitPlanMode carries the plan markdown) and the
//    Q&A card (AskUserQuestion — the questions live in the input, the user's selection + notes come back
//    in the tool_result's toolUseResult as {answers, annotations}, keyed by question text).
write(`projects/${PROJ}/sc-plan-0010.jsonl`, [
  userMsg("q1", 1, "Plan the move from session-token auth to OAuth"),
  asst("q2", 2, OPUS, [
    { type: "tool_use", id: "tu_ask", name: "AskUserQuestion", input: { questions: [
      { question: "Which OAuth provider should we integrate?", header: "Provider", multiSelect: false, options: [
        { label: "Auth0", description: "Managed, fastest to ship; per-MAU pricing." },
        { label: "Keycloak", description: "Self-hosted, no per-user cost; you run it." },
        { label: "Google only", description: "Simplest, but locks users to Google accounts." },
      ] },
      { question: "Which flows do we need on day one?", header: "Flows", multiSelect: true, options: [
        { label: "Authorization Code + PKCE", description: "Web + SPA sign-in." },
        { label: "Client Credentials", description: "Service-to-service tokens." },
        { label: "Device Code", description: "CLI / TV sign-in." },
      ] },
    ] } },
  ], usage(500, 130, 0, 2000)),
  toolResult("q3", 3, "tu_ask", { toolUseResult: {
    questions: [{ question: "Which OAuth provider should we integrate?" }, { question: "Which flows do we need on day one?" }],
    answers: { "Which OAuth provider should we integrate?": "Auth0", "Which flows do we need on day one?": ["Authorization Code + PKCE", "Client Credentials"] },
    annotations: { "Which OAuth provider should we integrate?": { notes: "Ship fast now; revisit self-hosting once we cross 50k MAU." } },
  } }),
  asst("q4", 4, OPUS, [
    { type: "tool_use", id: "tu_plan", name: "ExitPlanMode", input: { plan: "## Migrate session-token auth → OAuth (Auth0)\n\n**Context.** We're replacing home-grown session tokens with Auth0 so we stop maintaining our own login and get MFA for free.\n\n### Steps\n1. Add the Auth0 SDK and an `/auth/callback` route (Authorization Code + PKCE).\n2. Add a Client-Credentials token issuer for service-to-service calls.\n3. Migrate the session middleware to validate Auth0 JWTs; keep the old path behind a flag for one release.\n4. Backfill `user.external_id` from the current session store.\n5. Flip the flag, monitor error budget, then delete the legacy token code.\n\n### Verification\n- E2E sign-in through the real Auth0 tenant (staging).\n- Contract test the JWT validation middleware.\n- Canary 5% of traffic before full rollout." } },
  ], usage(700, 260, 0, 2500)),
  toolResult("q5", 5, "tu_plan"),
  asst("q6", 6, OPUS, [{ type: "text", text: "Plan approved — starting on the Auth0 SDK integration." }], usage(300, 80, 0, 3000)),
]);

// ── RICH DEMO SESSIONS ──────────────────────────────────────────────────────────────────────────
// A fleet of readable, fully-synthetic sessions spread across five projects, four models, and ~9 weeks
// (Jan–Mar 2026) with large/varied token usage — so the dashboard has real range (time-series, cost,
// by-model / by-project / by-category breakdowns) and every transcript browses as a real conversation.
// Used by the corpus-only demo (Pages + local server); no real data, no "[redacted]".
const API = "-demo-acme-api", WEB = "-demo-acme-web", INFRA = "-demo-acme-infra", MOBILE = "-demo-acme-mobile", DATA = "-demo-acme-data";
const P = { [API]: "/demo/acme-api", [WEB]: "/demo/acme-web", [INFRA]: "/demo/acme-infra", [MOBILE]: "/demo/acme-mobile", [DATA]: "/demo/acme-data" };
const big = (i, o, cw, cr) => usage(i, o, cw, cr); // alias for readability at call sites

richSession("rs-1001-ratelimit", API, P[API], OPUS, iso("2026-01-06", 9, 12), [
  { ask: "Add a token-bucket rate limiter to the public API", say: "I'll look at the middleware stack first.", tools: [
    { name: "Grep", input: { pattern: "app.use\\(", path: "src/server.ts" }, result: "src/server.ts:22: app.use(cors());\nsrc/server.ts:23: app.use(json());" },
    { name: "Read", input: { file_path: "src/server.ts" }, result: "import express from 'express';\nconst app = express();\napp.use(cors());\napp.use(json());" },
  ], usage: big(2400, 620, 4200, 38000) },
  { ask: "Use Redis for the bucket store", say: "Adding a Redis-backed limiter and wiring it in.", tools: [
    { name: "Write", input: { file_path: "src/mw/rateLimit.ts", content: "import { redis } from '../redis';\nexport function rateLimit(rpm: number) {\n  return async (req, res, next) => {\n    const key = `rl:${req.ip}`;\n    const n = await redis.incr(key);\n    if (n === 1) await redis.expire(key, 60);\n    if (n > rpm) return res.status(429).json({ error: 'rate limited' });\n    next();\n  };\n}" }, result: "File created successfully at: src/mw/rateLimit.ts" },
    { name: "Edit", input: { file_path: "src/server.ts", old_string: "app.use(json());", new_string: "app.use(json());\napp.use(rateLimit(600));" }, result: "The file src/server.ts has been updated." },
  ], usage: big(3100, 900, 0, 61000) },
  { ask: "Run the tests", tools: [
    { name: "Bash", input: { command: "pnpm test src/mw", description: "Run the middleware tests" }, result: " RUN  v4.1.9\n src/mw/rateLimit.test.ts\n   ✓ allows under the limit\n   ✓ 429s over the limit\n\n Test Files  1 passed (1)\n      Tests  2 passed (2)" },
  ], usage: big(1800, 300, 0, 72000) },
  { ask: "Ship it", say: "Rate limiter added, wired in, and tested. 600 rpm per IP with a 60s window.", usage: big(600, 180, 0, 74000) },
]);

richSession("rs-1002-nplusone", API, P[API], OPUS, iso("2026-01-08", 14, 3), [
  { ask: "The /orders list endpoint is slow — looks like an N+1", say: "Let me trace the query path.", tools: [
    { name: "Grep", input: { pattern: "customer", path: "src/orders.ts" }, result: "src/orders.ts:41:   const customer = await db.customer.find(o.customerId);" },
    { name: "Read", input: { file_path: "src/orders.ts" }, result: "for (const o of orders) {\n  const customer = await db.customer.find(o.customerId); // per-row query\n  o.customer = customer;\n}" },
  ], usage: big(2900, 540, 5000, 44000) },
  { ask: "Batch the customer lookups", tools: [
    { name: "Edit", input: { file_path: "src/orders.ts", old_string: "for (const o of orders) {\n  const customer = await db.customer.find(o.customerId); // per-row query\n  o.customer = customer;\n}", new_string: "const ids = [...new Set(orders.map((o) => o.customerId))];\nconst customers = await db.customer.findMany({ id: { in: ids } });\nconst byId = new Map(customers.map((c) => [c.id, c]));\nfor (const o of orders) o.customer = byId.get(o.customerId);" }, result: "The file src/orders.ts has been updated." },
    { name: "Bash", input: { command: "pnpm bench src/orders", description: "Re-run the orders benchmark" }, result: "before: 812ms (201 queries)\nafter:   34ms (2 queries)" },
  ], usage: big(2200, 700, 0, 66000) },
  { ask: "Great, 24x faster", say: "Collapsed 201 queries to 2 — p95 on /orders drops from 812ms to 34ms.", usage: big(500, 160, 0, 68000) },
]);

richSession("rs-1003-checkout", WEB, P[WEB], SONNET, iso("2026-01-09", 11, 30), [
  { ask: "Build the multi-step checkout flow (cart → address → payment → review)", say: "Scaffolding the wizard and its steps.", tools: [
    { name: "Write", input: { file_path: "src/checkout/Wizard.tsx", content: "export function Wizard() {\n  const [step, setStep] = useState(0);\n  const steps = [Cart, Address, Payment, Review];\n  const Step = steps[step];\n  return <Step onNext={() => setStep((s) => s + 1)} onBack={() => setStep((s) => s - 1)} />;\n}" }, result: "File created successfully at: src/checkout/Wizard.tsx" },
    { name: "Write", input: { file_path: "src/checkout/Address.tsx", content: "export function Address({ onNext, onBack }) {\n  const form = useForm(addressSchema);\n  return <form onSubmit={form.handleSubmit(onNext)}>...</form>;\n}" }, result: "File created successfully at: src/checkout/Address.tsx" },
  ], usage: big(3400, 1200, 6000, 29000) },
  { ask: "Persist progress to localStorage so a refresh doesn't lose it", tools: [
    { name: "MultiEdit", input: { file_path: "src/checkout/Wizard.tsx", edits: [
      { old_string: "const [step, setStep] = useState(0);", new_string: "const [step, setStep] = usePersistedState('checkout.step', 0);" },
      { old_string: "const steps = [Cart, Address, Payment, Review];", new_string: "const steps = [Cart, Address, Payment, Review];\n  useBeforeUnload(() => save('checkout.draft', form.values));" },
    ] }, result: "Applied 2 edits to src/checkout/Wizard.tsx" },
  ], usage: big(2100, 640, 0, 41000) },
  { ask: "Add the happy-path test", tools: [
    { name: "Bash", input: { command: "pnpm test checkout", description: "Run the checkout tests" }, result: " ✓ walks cart → address → payment → review\n ✓ restores a saved draft after reload\n\n Tests  2 passed (2)" },
  ], usage: big(1500, 380, 0, 52000) },
]);

richSession("rs-1004-darkmode", WEB, P[WEB], SONNET, iso("2026-01-13", 16, 20), [
  { ask: "Add a dark theme with a toggle, using CSS variables", say: "Adding a token layer and a data-theme switch.", tools: [
    { name: "MultiEdit", input: { file_path: "src/styles/tokens.css", edits: [
      { old_string: ":root {\n  --bg: #ffffff;\n  --fg: #1b1f27;\n}", new_string: ":root {\n  --bg: #ffffff;\n  --fg: #1b1f27;\n}\n:root[data-theme='dark'] {\n  --bg: #0f1115;\n  --fg: #e6e8ec;\n}" },
      { old_string: "body { background: #fff; color: #000; }", new_string: "body { background: var(--bg); color: var(--fg); }" },
    ] }, result: "Applied 2 edits to src/styles/tokens.css" },
    { name: "Write", input: { file_path: "src/ThemeToggle.tsx", content: "export function ThemeToggle() {\n  const [t, setT] = usePersistedState('theme', 'light');\n  useEffect(() => document.documentElement.setAttribute('data-theme', t), [t]);\n  return <button onClick={() => setT(t === 'light' ? 'dark' : 'light')}>{t === 'light' ? '🌙' : '☀️'}</button>;\n}" }, result: "File created successfully at: src/ThemeToggle.tsx" },
  ], usage: big(2600, 820, 3000, 33000) },
  { ask: "Make sure contrast passes AA", tools: [
    { name: "Bash", input: { command: "pnpm a11y:contrast", description: "Check color contrast ratios" }, result: "fg/bg (light): 15.9:1  PASS\nfg/bg (dark):  13.1:1  PASS\nmuted/bg (dark): 4.8:1  PASS" },
  ], usage: big(1200, 300, 0, 44000) },
]);

richSession("rs-1005-terraform", INFRA, P[INFRA], OPUS, iso("2026-01-15", 10, 5), [
  { ask: "Stand up a staging EKS cluster with Terraform", say: "Writing the module and a staging tfvars.", tools: [
    { name: "Write", input: { file_path: "infra/eks/main.tf", content: "module \"eks\" {\n  source          = \"terraform-aws-modules/eks/aws\"\n  cluster_name    = var.name\n  cluster_version = \"1.29\"\n  vpc_id          = var.vpc_id\n  subnet_ids      = var.subnet_ids\n  eks_managed_node_groups = {\n    default = { min_size = 2, max_size = 5, instance_types = [\"t3.large\"] }\n  }\n}" }, result: "File created successfully at: infra/eks/main.tf" },
    { name: "Bash", input: { command: "terraform -chdir=infra/eks plan -var-file=staging.tfvars", description: "Plan the staging cluster" }, result: "Plan: 37 to add, 0 to change, 0 to destroy.\n\nChanges to Outputs:\n  + cluster_endpoint = (known after apply)\n  + kubeconfig       = (sensitive value)" },
  ], usage: big(3800, 1100, 8000, 51000) },
  { ask: "Apply it", tools: [
    { name: "Bash", input: { command: "terraform -chdir=infra/eks apply -auto-approve -var-file=staging.tfvars", description: "Apply the staging cluster" }, result: "Apply complete! Resources: 37 added, 0 changed, 0 destroyed.\n\nOutputs:\ncluster_endpoint = \"https://ABCD.gr7.us-east-1.eks.amazonaws.com\"" },
  ], usage: big(1900, 520, 0, 88000) },
]);

richSession("rs-1006-flakyci", INFRA, P[INFRA], OPUS, iso("2026-01-19", 13, 40), [
  { ask: "The integration CI job is flaky — fails ~1 in 5 runs", say: "Let me pull the recent failures and look for a pattern.", tools: [
    { name: "Bash", input: { command: "gh run list --workflow ci.yml --limit 20 --json conclusion,databaseId --jq '.[]|select(.conclusion==\"failure\").databaseId'", description: "List recent failed CI runs" }, result: "8412093\n8409981\n8401220" },
    { name: "Bash", input: { command: "gh run view 8412093 --log-failed | grep -A3 'FAIL'", description: "Pull the failing log" }, result: "FAIL  test/integration/queue.test.ts > drains within 2s\n  expected 0 pending, got 3\n  (timeout after 2000ms)" },
  ], usage: big(2700, 700, 4000, 39000) },
  { ask: "Looks like a race on the queue drain", tools: [
    { name: "Edit", input: { file_path: "test/integration/queue.test.ts", old_string: "await sleep(2000);\nexpect(await queue.pending()).toBe(0);", new_string: "await waitFor(async () => (await queue.pending()) === 0, { timeout: 10000 });" }, result: "The file test/integration/queue.test.ts has been updated." },
    { name: "Bash", input: { command: "for i in $(seq 1 20); do pnpm test test/integration/queue.test.ts >/dev/null 2>&1 && echo pass || echo FAIL; done | sort | uniq -c", description: "Stress the test 20× to confirm the fix" }, result: "     20 pass" },
  ], usage: big(2300, 640, 0, 63000) },
  { ask: "20/20 green now", say: "Replaced the fixed sleep with a polling waitFor — the drain race is gone.", usage: big(500, 150, 0, 65000) },
]);

richSession("rs-1007-pgupgrade", DATA, P[DATA], OPUS, iso("2026-01-22", 9, 0), [
  { ask: "Plan and run the Postgres 14 → 16 upgrade on the warehouse replica", say: "This is involved — I'll delegate the compatibility audit to a subagent while I stage the dump.", tools: [
    { name: "Task", input: { subagent_type: "general-purpose", description: "Audit PG16 incompatibilities", prompt: "Scan our SQL + extensions for Postgres 16 breaking changes" }, result: "Audit complete: 2 issues found (see child).", extra: { status: "completed", agentId: "d1ab5e01", agentType: "general-purpose", totalTokens: 5200, totalDurationMs: 46000, totalToolUseCount: 7 } },
  ], usage: big(2100, 480, 6000, 22000) },
  { ask: "What did it find?", say: "Two things: `array_to_string(NULL)` behavior changed, and the `pg_stat_statements` column set moved. Both easy fixes.", tools: [
    { name: "Bash", input: { command: "pg_dump -Fc warehouse_replica > /backups/wh_pre16.dump && echo done", description: "Take a pre-upgrade dump" }, result: "done" },
    { name: "Bash", input: { command: "pg_upgrade --old-bindir=/usr/pg14/bin --new-bindir=/usr/pg16/bin --old-datadir=/data/14 --new-datadir=/data/16 --check", description: "Run pg_upgrade compatibility check" }, result: "Performing Consistency Checks\n-----------------------------\nChecking cluster versions                    ok\nChecking database user is the install user   ok\n*Clusters are compatible*" },
  ], usage: big(2600, 720, 0, 71000) },
  { ask: "Do the upgrade", tools: [
    { name: "Bash", input: { command: "pg_upgrade --old-bindir=/usr/pg14/bin --new-bindir=/usr/pg16/bin --old-datadir=/data/14 --new-datadir=/data/16 --link", description: "Run the in-place upgrade" }, result: "Upgrade Complete\n----------------\nOptimizer statistics are not transferred by pg_upgrade.\nRun: vacuumdb --all --analyze-in-stages" },
    { name: "Bash", input: { command: "vacuumdb --all --analyze-in-stages", description: "Rebuild optimizer stats" }, result: "vacuuming database \"warehouse_replica\"\nanalyzing (stage 3) ... done" },
  ], usage: big(1800, 560, 0, 96000) },
]);

richSession("rs-1008-push", MOBILE, P[MOBILE], SONNET, iso("2026-01-26", 15, 10), [
  { ask: "Wire up push notifications on iOS + Android via FCM", say: "Adding the client registration + a token sync hook.", tools: [
    { name: "Read", input: { file_path: "src/notifications/index.ts" }, result: "// TODO: register for push" },
    { name: "Write", input: { file_path: "src/notifications/index.ts", content: "import messaging from '@react-native-firebase/messaging';\nexport async function registerPush() {\n  const status = await messaging().requestPermission();\n  if (status !== messaging.AuthorizationStatus.AUTHORIZED) return null;\n  const token = await messaging().getToken();\n  await api.post('/devices', { token, platform: Platform.OS });\n  return token;\n}" }, result: "File created successfully at: src/notifications/index.ts" },
  ], usage: big(3000, 900, 5000, 31000) },
  { ask: "Handle foreground messages too", tools: [
    { name: "Edit", input: { file_path: "src/notifications/index.ts", old_string: "  return token;\n}", new_string: "  messaging().onMessage(async (m) => toast(m.notification?.title, m.notification?.body));\n  return token;\n}" }, result: "The file src/notifications/index.ts has been updated." },
    { name: "Bash", input: { command: "pnpm ios:build --scheme staging", description: "Build the iOS staging app" }, result: "** BUILD SUCCEEDED **\nInstalling on simulator iPhone 15 ... done" },
  ], usage: big(2000, 610, 0, 48000) },
]);

richSession("rs-1009-apidocs", API, P[API], HAIKU, iso("2026-01-28", 10, 45), [
  { ask: "Generate reference docs for the public REST API from the OpenAPI spec", tools: [
    { name: "Read", input: { file_path: "openapi.yaml" }, result: "openapi: 3.1.0\npaths:\n  /orders: { get: {...}, post: {...} }\n  /orders/{id}: { get: {...} }" },
    { name: "Bash", input: { command: "npx @redocly/cli build-docs openapi.yaml -o docs/api.html", description: "Render the OpenAPI docs" }, result: "Prerendering docs\n🎉 bundled successfully in: docs/api.html (312 KiB)" },
    { name: "Write", input: { file_path: "docs/README.md", content: "# API Reference\n\nRendered from `openapi.yaml`. See [api.html](./api.html). Auth: bearer token. Base URL: `https://api.acme.dev/v1`." }, result: "File created successfully at: docs/README.md" },
  ], usage: big(1600, 900, 2000, 12000) },
]);

richSession("rs-1010-authrefactor", API, P[API], OPUS, iso("2026-02-02", 11, 15), [
  { ask: "Refactor the auth module — split the 600-line auth.ts into middleware, tokens, and guards", say: "Extracting three focused modules and updating imports.", tools: [
    { name: "Read", input: { file_path: "src/auth.ts" }, result: "// 600 lines: signToken, verifyToken, requireRole, requireAuth, refresh, ..." },
    { name: "Write", input: { file_path: "src/auth/tokens.ts", content: "export function signToken(u: User) { /* ... */ }\nexport function verifyToken(t: string) { /* ... */ }" }, result: "File created successfully at: src/auth/tokens.ts" },
    { name: "Write", input: { file_path: "src/auth/guards.ts", content: "export const requireAuth = (req, res, next) => { /* ... */ };\nexport const requireRole = (role) => (req, res, next) => { /* ... */ };" }, result: "File created successfully at: src/auth/guards.ts" },
  ], usage: big(4200, 1400, 9000, 58000) },
  { ask: "Update the imports across the codebase", tools: [
    { name: "Grep", input: { pattern: "from ['\\\"].*/auth['\\\"]", output_mode: "files_with_matches" }, result: "src/server.ts\nsrc/routes/orders.ts\nsrc/routes/users.ts\nsrc/routes/admin.ts" },
    { name: "Bash", input: { command: "pnpm tsc --noEmit", description: "Type-check after the refactor" }, result: "No errors found." },
  ], usage: big(2400, 700, 0, 84000) },
  { ask: "Nice, run the full suite", tools: [
    { name: "Bash", input: { command: "pnpm test", description: "Run the full test suite" }, result: " Test Files  38 passed (38)\n      Tests  412 passed (412)\n   Duration  9.1s" },
  ], usage: big(1400, 340, 0, 92000) },
]);

richSession("rs-1011-memleak", WEB, P[WEB], OPUS, iso("2026-02-05", 14, 25), [
  { ask: "The dashboard tab grows to 1.5GB after an hour — find the leak", say: "I'll take a heap diff, and spin up a subagent to grep for un-cleaned listeners in parallel.", tools: [
    { name: "Task", input: { subagent_type: "general-purpose", description: "Find un-removed event listeners", prompt: "grep for addEventListener / setInterval without matching cleanup" }, result: "Found 3 suspects (see child).", extra: { status: "completed", agentId: "f00dcafe", agentType: "general-purpose", totalTokens: 4100, totalDurationMs: 38000, totalToolUseCount: 6 } },
    { name: "Bash", input: { command: "node --expose-gc scripts/heapdiff.js /dashboard", description: "Capture a heap diff on the dashboard route" }, result: "retained growth: +214MB\ntop retainer: WebSocket listeners (3,180 instances)" },
  ], usage: big(3300, 780, 7000, 41000) },
  { ask: "The subagent found the WS listener — fix it", tools: [
    { name: "Edit", input: { file_path: "src/hooks/useLiveData.ts", old_string: "useEffect(() => {\n  ws.on('tick', onTick);\n}, []);", new_string: "useEffect(() => {\n  ws.on('tick', onTick);\n  return () => ws.off('tick', onTick);\n}, []);" }, result: "The file src/hooks/useLiveData.ts has been updated." },
    { name: "Bash", input: { command: "node --expose-gc scripts/heapdiff.js /dashboard", description: "Re-run the heap diff after the fix" }, result: "retained growth: +3MB\ntop retainer: (stable)" },
  ], usage: big(2100, 560, 0, 76000) },
]);

richSession("rs-1012-e2e-signup", WEB, P[WEB], SONNET, iso("2026-02-09", 10, 30), [
  { ask: "Add a Playwright e2e test for the signup → verify-email → onboarding flow", tools: [
    { name: "Write", input: { file_path: "e2e/signup.spec.ts", content: "test('new user signs up and lands on onboarding', async ({ page }) => {\n  await page.goto('/signup');\n  await page.fill('#email', 'demo+e2e@acme.dev');\n  await page.fill('#password', 'S3cure!pw');\n  await page.click('text=Create account');\n  await page.click(await mailbox.lastVerifyLink());\n  await expect(page).toHaveURL(/\\/onboarding/);\n});" }, result: "File created successfully at: e2e/signup.spec.ts" },
    { name: "Bash", input: { command: "npx playwright test e2e/signup.spec.ts", description: "Run the new e2e test" }, result: "Running 1 test using 1 worker\n  ✓  signup.spec.ts:1 › new user signs up (4.2s)\n\n  1 passed (5s)" },
  ], usage: big(2200, 780, 3000, 36000) },
]);

richSession("rs-1013-otel", INFRA, P[INFRA], OPUS, iso("2026-02-12", 16, 0), [
  { ask: "Instrument the API with OpenTelemetry traces + a Grafana Tempo exporter", say: "Adding the SDK bootstrap and auto-instrumentation.", tools: [
    { name: "Write", input: { file_path: "src/otel.ts", content: "import { NodeSDK } from '@opentelemetry/sdk-node';\nimport { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';\nnew NodeSDK({\n  serviceName: 'acme-api',\n  traceExporter: new OTLPTraceExporter({ url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }),\n  instrumentations: [getNodeAutoInstrumentations()],\n}).start();" }, result: "File created successfully at: src/otel.ts" },
    { name: "Edit", input: { file_path: "src/server.ts", old_string: "import express from 'express';", new_string: "import './otel'; // must be first\nimport express from 'express';" }, result: "The file src/server.ts has been updated." },
    { name: "Bash", input: { command: "curl -s localhost:3000/health && curl -s tempo:3200/api/search?limit=1 | jq '.traces|length'", description: "Confirm a trace reached Tempo" }, result: "{\"ok\":true}\n1" },
  ], usage: big(3600, 980, 6000, 54000) },
]);

richSession("rs-1014-bundle", WEB, P[WEB], SONNET, iso("2026-02-16", 13, 20), [
  { ask: "Our JS bundle is 1.2MB — get it under 500KB", say: "Analyzing the bundle first.", tools: [
    { name: "Bash", input: { command: "npx vite-bundle-visualizer --json | jq -r '.[]|select(.size>80000)|\"\\(.name) \\(.size)\"'", description: "Find the largest bundle chunks" }, result: "moment 231000\nlodash 118000\nchart.js 96000" },
    { name: "MultiEdit", input: { file_path: "src/utils/time.ts", edits: [
      { old_string: "import moment from 'moment';", new_string: "import { format, formatDistanceToNow } from 'date-fns';" },
      { old_string: "export const ago = (d) => moment(d).fromNow();", new_string: "export const ago = (d) => formatDistanceToNow(d, { addSuffix: true });" },
    ] }, result: "Applied 2 edits to src/utils/time.ts" },
  ], usage: big(2500, 720, 4000, 47000) },
  { ask: "Drop lodash too, then rebuild", tools: [
    { name: "Bash", input: { command: "pnpm build && du -sh dist/assets/*.js | sort -h | tail -1", description: "Rebuild and measure the largest chunk" }, result: "vite v6 building for production...\n✓ built in 6.2s\n472K dist/assets/index-a1b2c3.js" },
  ], usage: big(1600, 420, 0, 61000) },
  { ask: "472K — under budget 🎉", say: "Swapped moment→date-fns and dropped lodash: 1.2MB → 472KB (-61%).", usage: big(500, 160, 0, 63000) },
]);

richSession("rs-1015-schema", DATA, P[DATA], OPUS, iso("2026-02-19", 9, 40), [
  { ask: "Design the schema for a notifications system (per-user, multi-channel, read receipts)", say: "Proposing tables + indexes; here's the migration.", tools: [
    { name: "Write", input: { file_path: "migrations/0042_notifications.sql", content: "CREATE TABLE notifications (\n  id           bigserial PRIMARY KEY,\n  user_id      bigint NOT NULL REFERENCES users(id),\n  channel      text NOT NULL CHECK (channel IN ('email','push','in_app')),\n  payload      jsonb NOT NULL,\n  read_at      timestamptz,\n  created_at   timestamptz NOT NULL DEFAULT now()\n);\nCREATE INDEX idx_notif_user_unread ON notifications (user_id) WHERE read_at IS NULL;" }, result: "File created successfully at: migrations/0042_notifications.sql" },
    { name: "Bash", input: { command: "psql -f migrations/0042_notifications.sql && psql -c '\\d+ notifications'", description: "Apply and describe the new table" }, result: "CREATE TABLE\nCREATE INDEX\n              Table \"public.notifications\"\n Column | Type | ...\n Indexes:\n  \"idx_notif_user_unread\" btree (user_id) WHERE read_at IS NULL" },
  ], usage: big(3100, 1050, 5000, 49000) },
]);

richSession("rs-1016-search", API, P[API], OPUS, iso("2026-02-24", 15, 5), [
  { ask: "Add full-text search over products with Postgres tsvector + a ranked endpoint", say: "Adding a generated tsvector column, a GIN index, and the query.", tools: [
    { name: "Write", input: { file_path: "migrations/0043_product_fts.sql", content: "ALTER TABLE products ADD COLUMN search tsvector\n  GENERATED ALWAYS AS (to_tsvector('english', name || ' ' || coalesce(description,''))) STORED;\nCREATE INDEX idx_products_search ON products USING gin(search);" }, result: "File created successfully at: migrations/0043_product_fts.sql" },
    { name: "Edit", input: { file_path: "src/products.ts", old_string: "export async function search(q) {\n  return db.query('SELECT * FROM products WHERE name ILIKE $1', [`%${q}%`]);\n}", new_string: "export async function search(q) {\n  return db.query(\n    `SELECT *, ts_rank(search, plainto_tsquery('english', $1)) AS rank\n     FROM products WHERE search @@ plainto_tsquery('english', $1)\n     ORDER BY rank DESC LIMIT 50`, [q]);\n}" }, result: "The file src/products.ts has been updated." },
    { name: "Bash", input: { command: "curl -s 'localhost:3000/products/search?q=wireless+headphones' | jq '.[0].name'", description: "Smoke-test the ranked search" }, result: "\"Wireless Noise-Cancelling Headphones\"" },
  ], usage: big(3400, 920, 7000, 57000) },
]);

richSession("rs-1017-webhooks", API, P[API], FABLE, iso("2026-03-02", 10, 50), [
  { ask: "Add signed outbound webhooks with retries and a dead-letter queue", say: "Adding HMAC signing, exponential backoff, and a DLQ table.", tools: [
    { name: "Write", input: { file_path: "src/webhooks/deliver.ts", content: "export async function deliver(hook, event) {\n  const body = JSON.stringify(event);\n  const sig = hmac(hook.secret, body);\n  for (let attempt = 0; attempt < 5; attempt++) {\n    const res = await fetch(hook.url, { method: 'POST', headers: { 'X-Signature': sig }, body });\n    if (res.ok) return;\n    await sleep(2 ** attempt * 1000);\n  }\n  await dlq.add({ hook: hook.id, event });\n}" }, result: "File created successfully at: src/webhooks/deliver.ts" },
    { name: "Bash", input: { command: "pnpm test webhooks", description: "Run the webhook delivery tests" }, result: " ✓ signs the payload with HMAC-SHA256\n ✓ retries with backoff then dead-letters\n\n Tests  2 passed (2)" },
  ], usage: big(2800, 860, 5000, 45000) },
]);

richSession("rs-1018-cache", API, P[API], OPUS, iso("2026-03-06", 14, 15), [
  { ask: "Add a read-through cache to the product catalog with stale-while-revalidate", say: "Wrapping the repository with an SWR cache layer.", tools: [
    { name: "Read", input: { file_path: "src/catalog.ts" }, result: "export const getProduct = (id) => db.product.find(id);" },
    { name: "Edit", input: { file_path: "src/catalog.ts", old_string: "export const getProduct = (id) => db.product.find(id);", new_string: "export const getProduct = swr({\n  key: (id) => `product:${id}`,\n  ttl: 60, staleTtl: 600,\n  fetch: (id) => db.product.find(id),\n});" }, result: "The file src/catalog.ts has been updated." },
    { name: "Bash", input: { command: "pnpm bench catalog", description: "Benchmark the cached catalog reads" }, result: "cold:  41ms\nwarm:  0.8ms (cache hit)\nstale: 0.9ms (served stale, revalidated in bg)" },
  ], usage: big(2600, 700, 4000, 68000) },
]);

// Four large, long-running sessions to spread the Complexity-bands chart (small → xl).
bigSession("rs-2001-payments-migrate", API, P[API], OPUS, iso("2026-01-12", 9, 0), {
  intro: "Migrate the payments service off the legacy gateway to the new provider SDK",
  modules: ["charges", "refunds", "payouts", "disputes", "webhooks", "reconcile", "ledger", "invoices", "subscriptions", "coupons", "tax", "fx"],
  tokenScale: 4, gapMin: 16,
  sub: { agentId: "aud17c01", desc: "Audit payment seams", prompt: "Check idempotency + currency handling across the migrated payment modules" },
});
bigSession("rs-2002-search-epic", DATA, P[DATA], OPUS, iso("2026-01-30", 10, 0), {
  intro: "Build the new search stack: ingestion, indexing, ranking, and the query API",
  modules: ["ingest", "tokenizer", "index", "ranker", "query", "facets", "suggest"],
  tokenScale: 3, gapMin: 8,
});
bigSession("rs-2003-web-refactor", WEB, P[WEB], SONNET, iso("2026-02-13", 13, 0), {
  intro: "Refactor the component library onto the new design tokens",
  modules: ["button", "input", "card", "modal", "table", "tabs"],
  tokenScale: 2, gapMin: 6,
});
bigSession("rs-2004-outage-postmortem", INFRA, P[INFRA], OPUS, iso("2026-02-26", 8, 0), {
  intro: "Investigate and remediate the Feb 26 cascading outage across the platform",
  modules: ["gateway", "auth", "orders", "inventory", "notifications", "billing", "search", "cache", "queue", "scheduler", "webhooks", "reporting", "sessions", "payments", "shipping", "catalog", "reviews", "analytics", "email", "sms"],
  tokenScale: 6, gapMin: 22,
  sub: { agentId: "0ff11ne9", desc: "Correlate error spikes to deploys", prompt: "Cross-reference the error-rate spike windows with the deploy timeline across all services" },
});
write(`projects/${API}/rs-2001-payments-migrate/subagents/agent-aud17c01.jsonl`, [
  u("aud1", { type: "user", timestamp: iso("2026-01-12", 11, 30), isSidechain: true, agentId: "aud17c01", cwd: P[API], message: { role: "user", content: "Check idempotency + currency handling across the migrated payment modules" } }),
  u("aud2", { type: "assistant", timestamp: iso("2026-01-12", 11, 34), isSidechain: true, agentId: "aud17c01", message: { role: "assistant", id: "msg_aud2", model: HAIKU, content: [{ type: "text", text: "Idempotency keys are consistent; one issue — refunds rounds to 2dp before the currency-minor-unit conversion. Flagged for a follow-up." }], usage: usage(5200, 780, 0, 2400) } }),
]);
write(`projects/${API}/rs-2001-payments-migrate/subagents/agent-aud17c01.meta.json`, [{ agentType: "general-purpose", description: "Audit payment seams", toolUseId: "rs-2001-payments-migrate-t0-0", spawnDepth: 1 }]);
write(`projects/${INFRA}/rs-2004-outage-postmortem/subagents/agent-0ff11ne9.jsonl`, [
  u("out1", { type: "user", timestamp: iso("2026-02-26", 10, 15), isSidechain: true, agentId: "0ff11ne9", cwd: P[INFRA], message: { role: "user", content: "Cross-reference the error-rate spike windows with the deploy timeline across all services" } }),
  u("out2", { type: "assistant", timestamp: iso("2026-02-26", 10, 22), isSidechain: true, agentId: "0ff11ne9", message: { role: "assistant", id: "msg_out2", model: HAIKU, content: [{ type: "text", text: "The spike starts 40s after the gateway v812 deploy; the connection-pool cap (100) was exhausted under the retry storm. Root cause: no jittered backoff." }], usage: usage(6100, 900, 0, 3100) } }),
]);
write(`projects/${INFRA}/rs-2004-outage-postmortem/subagents/agent-0ff11ne9.meta.json`, [{ agentType: "general-purpose", description: "Correlate error spikes to deploys", toolUseId: "rs-2004-outage-postmortem-t0-0", spawnDepth: 1 }]);

// Subagent transcripts + meta for the two Task spawns above (rich fan-out for the dashboard).
write(`projects/${DATA}/rs-1007-pgupgrade/subagents/agent-d1ab5e01.jsonl`, [
  u("pgc1", { type: "user", timestamp: iso("2026-01-22", 9, 2), isSidechain: true, agentId: "d1ab5e01", cwd: P[DATA], message: { role: "user", content: "Scan our SQL + extensions for Postgres 16 breaking changes" } }),
  u("pgc2", { type: "assistant", timestamp: iso("2026-01-22", 9, 3), isSidechain: true, agentId: "d1ab5e01", message: { role: "assistant", id: "msg_pgc2", model: HAIKU, content: [{ type: "text", text: "Two breaking changes: array_to_string(NULL) now returns NULL (was ''), and pg_stat_statements dropped the `queryid` alias. Everything else is compatible." }], usage: usage(3200, 480, 0, 1500) } }),
]);
write(`projects/${DATA}/rs-1007-pgupgrade/subagents/agent-d1ab5e01.meta.json`, [{ agentType: "general-purpose", description: "Audit PG16 incompatibilities", toolUseId: "rs-1007-pgupgrade-t0-0", spawnDepth: 1 }]);
write(`projects/${WEB}/rs-1011-memleak/subagents/agent-f00dcafe.jsonl`, [
  u("f1", { type: "user", timestamp: iso("2026-02-05", 14, 27), isSidechain: true, agentId: "f00dcafe", cwd: P[WEB], message: { role: "user", content: "grep for addEventListener / setInterval without matching cleanup" } }),
  u("f2", { type: "assistant", timestamp: iso("2026-02-05", 14, 28), isSidechain: true, agentId: "f00dcafe", message: { role: "assistant", id: "msg_f2", model: HAIKU, content: [{ type: "text", text: "3 suspects; the hot one is src/hooks/useLiveData.ts — ws.on('tick') with no ws.off in the effect cleanup." }], usage: usage(2600, 420, 0, 1200) } }),
]);
write(`projects/${WEB}/rs-1011-memleak/subagents/agent-f00dcafe.meta.json`, [{ agentType: "general-purpose", description: "Find un-removed event listeners", toolUseId: "rs-1011-memleak-t0-0", spawnDepth: 1 }]);

console.log(`build-scenarios: wrote synthetic scenario corpus to ${ROOT}`);
