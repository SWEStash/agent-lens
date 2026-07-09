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

console.log(`build-scenarios: wrote synthetic scenario corpus to ${ROOT}`);
