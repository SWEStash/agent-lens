#!/usr/bin/env node
/**
 * Generate the synthetic "scenarios" corpus source (validation Layer 4/5). Unlike the redacted real
 * sources (team-a/team-b, which prove the redaction oracle), these are hand-authored, contain NO real
 * data, and use readable fake content — so they (a) represent every pipeline scenario end-to-end in
 * the sandbox and (b) make decent demo screenshots. Committed output; re-runnable & deterministic.
 *
 * Scenarios covered (one source = three claude configs once team-a/team-b are added → multi-source):
 *   plain · subagents (Task, no double-count) · workflow fan-out (orphan agents) · compaction/meta
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

// 3) WORKFLOW FAN-OUT: an orchestrator invokes the Workflow tool; its agents are sidechains linked via
//    a journal, NOT a Task/Agent tool_use — so they ingest as ORPHANS (parent_session_id = NULL). Each
//    agent's tokens are counted in its own session and do not roll up (documents finding #1).
write(`projects/${PROJ}/sc-workflow-0003.jsonl`, [
  userMsg("w1", 1, "Run the full DB migration workflow"),
  asst("w2", 2, OPUS, [{ type: "tool_use", id: "tu_wf", name: "Workflow", input: { name: "migrate" } }], usage(800, 100, 0, 1000)),
  toolResult("w3", 9, "tu_wf"), // no toolUseResult.agentId — Workflow links no single agent
  asst("w4", 10, OPUS, [{ type: "text", text: "Migration complete." }], usage(300, 50, 0, 2000)),
]);
for (const [n, table, i, o] of [["wf01", "users", 1000, 120], ["wf02", "orders", 1100, 130]]) {
  write(`projects/${PROJ}/sc-workflow-0003/subagents/agent-${n}.jsonl`, [
    u(`${n}a`, { type: "user", timestamp: ts(3), isSidechain: true, agentId: n, cwd: CWD, message: { role: "user", content: `migrate table ${table}` } }),
    u(`${n}b`, { type: "assistant", timestamp: ts(4), isSidechain: true, agentId: n, message: { role: "assistant", id: `msg_${n}`, model: HAIKU, content: [{ type: "text", text: `migrated ${table}` }], usage: usage(i, o, 0, 0) } }),
  ]);
}

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

console.log(`build-scenarios: wrote synthetic scenario corpus to ${ROOT}`);
