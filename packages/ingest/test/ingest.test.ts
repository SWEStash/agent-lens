/**
 * Ingester golden test — drives the real ingest engine (pipeline.ts) over synthetic, privacy-safe
 * JSONL fixtures and asserts the normalized rows. Doubles as the regression test for:
 *   - Skill name extraction (input.skill)
 *   - subagent → parent-turn linkage (toolUseResult.agentId → spawned_session_id → parent_*)
 *   - zero-turn sessions (a session whose only line is meta/empty produces 0 turns, no crash)
 *
 * Imports the BUILT output (dist) so it exercises exactly what ships and sidesteps NodeNext .js
 * specifier resolution; the root `test` script builds first.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { SourceFile } from "@agent-lens/core";
import { openDb } from "../dist/db.js";
import { prepareStatements, ingestFile, rebuildDerived, newStats } from "../dist/pipeline.js";
import { classify } from "../dist/classify.js";
import { ClaudeCodeAdapter } from "../dist/adapters/claude-code.js";

const SOURCE = "test";
const AGENT = "claude-code";
const T = (n: number) => `2026-01-01T00:0${n}:00.000Z`; // distinct ordered timestamps

function jsonl(...lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function file(sessionId: string, content: string): { file: SourceFile; content: string } {
  return {
    file: { path: `/fixtures/${sessionId}.jsonl`, sessionId, encodedDir: "-fixtures", isVersion: false, sourceId: SOURCE },
    content,
  };
}

// Parent session: user prompt → assistant w/ Skill call → tool_result → assistant w/ Agent tool_use
// → tool_result carrying toolUseResult.agentId → final assistant text. Tokens on assistant lines.
const PARENT = file(
  "sess-parent-1",
  jsonl(
    { uuid: "u1", type: "user", timestamp: T(1), cwd: "/tmp/proj", gitBranch: "main", version: "1.2.3", message: { role: "user", content: "Add a parser feature and explore the repo" } },
    { uuid: "u2", type: "assistant", timestamp: T(2), message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "Routing." }, { type: "tool_use", id: "toolu_skill1", name: "Skill", input: { skill: "test-suite-design" } }], usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    { uuid: "u3", type: "user", timestamp: T(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_skill1", content: "skill loaded" }] } },
    { uuid: "u4", type: "assistant", timestamp: T(4), message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "tool_use", id: "toolu_agent1", name: "Agent", input: { subagent_type: "Explore", prompt: "Explore the repo" } }], usage: { input_tokens: 80, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    { uuid: "u5", type: "user", timestamp: T(5), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_agent1", content: "exploration done" }] }, toolUseResult: { status: "completed", agentId: "deadbeef01", agentType: "Explore", totalTokens: 1234, totalDurationMs: 5000, totalToolUseCount: 3 } },
    { uuid: "u6", type: "assistant", timestamp: T(6), message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "All done." }], usage: { input_tokens: 50, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
  ),
);

// Subagent transcript: keyed off agentId via the filename stem (agent-<agentId>), all sidechain.
const SUBAGENT = file(
  "agent-deadbeef01",
  jsonl(
    { uuid: "s1", type: "user", timestamp: T(4), isSidechain: true, agentId: "deadbeef01", message: { role: "user", content: "Explore the repo" } },
    { uuid: "s2", type: "assistant", timestamp: T(5), isSidechain: true, agentId: "deadbeef01", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "Found the modules." }], usage: { input_tokens: 200, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
  ),
);

// Zero-turn session: the only line is a meta user line with empty content → an event, but no turn.
const ZERO = file(
  "sess-zero",
  jsonl({ uuid: "z1", type: "user", timestamp: T(1), isMeta: true, cwd: "/tmp/proj", message: { role: "user", content: "" } }),
);

// Multi-content-block response: Claude Code logs ONE API response as several JSONL lines (one per
// content block) and stamps the IDENTICAL usage (and message.id) on each. The ingest must count
// that response's tokens ONCE — not once per block — via the (session_id, message_id) dedup.
const DUP_USAGE = { input_tokens: 500, output_tokens: 60, cache_creation_input_tokens: 100, cache_read_input_tokens: 9000 };
const MULTIBLOCK = file(
  "sess-multiblock",
  jsonl(
    { uuid: "mb0", type: "user", timestamp: T(1), message: { role: "user", content: "Do a multi-tool task" } },
    { uuid: "mb1", type: "assistant", timestamp: T(2), message: { role: "assistant", id: "msg_dup1", model: "claude-opus-4-8", content: [{ type: "text", text: "Working." }], usage: DUP_USAGE } },
    { uuid: "mb2", type: "assistant", timestamp: T(2), message: { role: "assistant", id: "msg_dup1", model: "claude-opus-4-8", content: [{ type: "tool_use", id: "toolu_x", name: "Read", input: {} }], usage: DUP_USAGE } },
    { uuid: "mb3", type: "assistant", timestamp: T(2), message: { role: "assistant", id: "msg_dup1", model: "claude-opus-4-8", content: [{ type: "tool_use", id: "toolu_y", name: "Read", input: {} }], usage: DUP_USAGE } },
  ),
);

let db: ReturnType<typeof openDb>;

beforeAll(() => {
  db = openDb(":memory:");
  const stmts = prepareStatements(db);
  const stats = newStats();
  const now = "2026-01-01T00:00:00.000Z";
  const adapter = new ClaudeCodeAdapter();
  // Agent + source must exist before sessions reference them (FK).
  stmts.insAgent.run(AGENT, "Claude Code CLI");
  stmts.insSource.run({ id: SOURCE, label: SOURCE, agent_id: AGENT, config_dir: null });
  for (const f of [PARENT, SUBAGENT, ZERO, MULTIBLOCK]) {
    ingestFile(db, stmts, adapter, f.file, f.content, { size: f.content.length, mtimeMs: 0, hash: f.file.sessionId }, now, stats);
  }
  rebuildDerived(db);
  classify(db);
});

describe("ingest pipeline (golden fixtures)", () => {
  it("creates one session per transcript file", () => {
    const n = (db.prepare("SELECT COUNT(*) n FROM sessions").get() as any).n;
    expect(n).toBe(4);
  });

  it("extracts skill_name from a Skill tool_use", () => {
    const row = db.prepare("SELECT skill_name FROM tool_calls WHERE id = ?").get("toolu_skill1") as any;
    expect(row.skill_name).toBe("test-suite-design");
  });

  it("records agent_type and spawned_session_id on an Agent tool_use", () => {
    const row = db.prepare("SELECT agent_type, spawned_session_id, status FROM tool_calls WHERE id = ?").get("toolu_agent1") as any;
    expect(row.agent_type).toBe("Explore");
    expect(row.spawned_session_id).toBe("agent-deadbeef01");
    expect(row.status).toBe("completed"); // patched from toolUseResult
  });

  it("links the subagent session back to the spawning parent turn", () => {
    const sub = db.prepare("SELECT is_sidechain, parent_session_id, parent_turn_id FROM sessions WHERE id = ?").get("agent-deadbeef01") as any;
    expect(sub.is_sidechain).toBe(1);
    expect(sub.parent_session_id).toBe("sess-parent-1");
    // The parent's first (and only) turn.
    expect(sub.parent_turn_id).toBe("sess-parent-1:0");
    const turn = db.prepare("SELECT session_id FROM turns WHERE id = ?").get(sub.parent_turn_id) as any;
    expect(turn.session_id).toBe("sess-parent-1");
  });

  it("builds exactly one turn for the parent session", () => {
    const n = (db.prepare("SELECT COUNT(*) n FROM turns WHERE session_id = ?").get("sess-parent-1") as any).n;
    expect(n).toBe(1);
  });

  it("records token usage per assistant event", () => {
    const n = (db.prepare("SELECT COUNT(*) n FROM token_usage").get() as any).n;
    expect(n).toBe(5); // u2, u4, u6, s2 (no message.id → kept per-event), + 1 deduped multiblock
    const u2 = db.prepare("SELECT input_tokens, output_tokens FROM token_usage WHERE event_uuid = ?").get("u2") as any;
    expect(u2.input_tokens).toBe(100);
    expect(u2.output_tokens).toBe(20);
  });

  it("counts a multi-content-block response's usage exactly once (not per block)", () => {
    const rows = db
      .prepare("SELECT event_uuid, input_tokens, output_tokens, cache_read_input_tokens FROM token_usage WHERE session_id = ?")
      .all("sess-multiblock") as any[];
    expect(rows.length).toBe(1); // mb1/mb2/mb3 share message.id msg_dup1 → deduped
    expect(rows[0].input_tokens).toBe(500); // counted once, not 1500
    expect(rows[0].cache_read_input_tokens).toBe(9000); // not 27000
    // Aggregating the whole session must not triple-count the cached prefix.
    const sum = db
      .prepare("SELECT SUM(input_tokens) i, SUM(cache_read_input_tokens) cr FROM token_usage WHERE session_id = ?")
      .get("sess-multiblock") as any;
    expect(sum.i).toBe(500);
    expect(sum.cr).toBe(9000);
  });

  it("handles a zero-turn session without crashing", () => {
    const z = db.prepare("SELECT turn_count, event_count FROM sessions WHERE id = ?").get("sess-zero") as any;
    expect(z.turn_count).toBe(0);
    expect(z.event_count).toBe(1);
  });

  it("classifies every session (incl. the zero-turn one)", () => {
    const n = (db.prepare("SELECT COUNT(*) n FROM classifications WHERE scope = 'session'").get() as any).n;
    expect(n).toBe(4);
  });
});

// A non-transcript .jsonl that lives under projects/ (e.g. a Workflow tool's journal.jsonl, whose
// lines carry no `uuid`) gets swept up by discover() and creates a session stub with zero events.
// rebuildDerived must prune it so it never surfaces as a phantom empty session in the UI/counts.
describe("prunes phantom zero-event sessions (e.g. workflow journals)", () => {
  let pdb: ReturnType<typeof openDb>;
  beforeAll(() => {
    pdb = openDb(":memory:");
    const stmts = prepareStatements(pdb);
    const stats = newStats();
    const now = "2026-01-01T00:00:00.000Z";
    const adapter = new ClaudeCodeAdapter();
    stmts.insAgent.run(AGENT, "Claude Code CLI");
    stmts.insSource.run({ id: SOURCE, label: SOURCE, agent_id: AGENT, config_dir: null });
    // A real transcript + a journal-like file whose lines have no uuid → no events.
    const real = file("sess-real", jsonl({ uuid: "r1", type: "user", timestamp: T(1), cwd: "/tmp/p", message: { role: "user", content: "do it" } }));
    const journal = file(
      "journal",
      jsonl(
        { type: "started", key: "v2:abc", agentId: "a1" },
        { type: "result", key: "v2:abc", agentId: "a1", result: { cases: [] } },
      ),
    );
    for (const f of [real, journal]) {
      ingestFile(pdb, stmts, adapter, f.file, f.content, { size: f.content.length, mtimeMs: 0, hash: f.file.sessionId }, now, stats);
    }
    // Pre-condition: the stub exists before rebuild (proves the bug's source).
    expect((pdb.prepare("SELECT COUNT(*) n FROM sessions WHERE id = 'journal'").get() as any).n).toBe(1);
    rebuildDerived(pdb);
    classify(pdb);
  });

  it("drops the zero-event 'journal' session", () => {
    const n = (pdb.prepare("SELECT COUNT(*) n FROM sessions WHERE id = 'journal'").get() as any).n;
    expect(n).toBe(0);
  });

  it("keeps the real transcript session", () => {
    const real = pdb.prepare("SELECT event_count FROM sessions WHERE id = 'sess-real'").get() as any;
    expect(real.event_count).toBe(1);
    expect((pdb.prepare("SELECT COUNT(*) n FROM sessions").get() as any).n).toBe(1);
  });

  it("leaves no orphaned classification for the pruned session", () => {
    const n = (pdb.prepare("SELECT COUNT(*) n FROM classifications WHERE target_id = 'journal'").get() as any).n;
    expect(n).toBe(0);
  });
});
