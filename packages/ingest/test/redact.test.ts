/**
 * Redactor (validation Layer 4) — proves the central contract WITHOUT touching real data:
 *   (1) redaction is metric-preserving — ingest the RAW transcripts and the REDACTED transcripts
 *       into two DBs and assert every numeric/structural metric is identical (the "oracle"). The
 *       text-derived classifier *category* is deliberately excluded.
 *   (2) redaction is leak-free — known PII (emails, home paths, URLs) is present in the raw bytes
 *       and absent from the redacted bytes (findLeak proves the scan is meaningful).
 *
 * Imports the BUILT dist so it exercises exactly what ships.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { SourceFile } from "@agent-lens/core";
import { costForUsage } from "@agent-lens/core";
import { openDb } from "../dist/db.js";
import { prepareStatements, ingestFile, rebuildDerived, newStats } from "../dist/pipeline.js";
import { classify } from "../dist/classify.js";
import { ClaudeCodeAdapter } from "../dist/adapters/claude-code.js";
import { Redactor, findLeak } from "../dist/redact.js";

const SOURCE = "test";
const AGENT = "claude-code";
const T = (n: number) => `2026-01-01T00:0${n}:00.000Z`;
const jsonl = (...l: unknown[]) => l.map((x) => JSON.stringify(x)).join("\n") + "\n";

// A main session (PII-laden) that spawns an Explore subagent, plus the subagent transcript.
const RAW: Array<{ id: string; content: string }> = [
  {
    id: "sess-A",
    content: jsonl(
      { uuid: "u1", type: "user", timestamp: T(1), cwd: "/home/alice/projects/secret-app", gitBranch: "feature/acme-launch", version: "1.2.3", message: { role: "user", content: "Fix the login bug; ping alice@acme.com or see https://acme.com/internal" } },
      { uuid: "u2", type: "assistant", timestamp: T(2), message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "On it, alice." }, { type: "tool_use", id: "tu_skill", name: "Skill", input: { skill: "tdd-workflow" } }], usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 10, cache_read_input_tokens: 500 } } },
      { uuid: "u3", type: "user", timestamp: T(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_skill", content: "loaded /home/alice/.claude" }] } },
      { uuid: "u4", type: "assistant", timestamp: T(4), message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "tool_use", id: "tu_w", name: "Write", input: { file_path: "/home/alice/projects/secret-app/src/main.ts", content: "const a=1\nconst b=2\nconst c=3" } }], usage: { input_tokens: 80, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 } } },
      { uuid: "u5", type: "assistant", timestamp: T(5), message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "tool_use", id: "tu_e", name: "Edit", input: { file_path: "/home/alice/projects/secret-app/src/main.ts", old_string: "old\nlines", new_string: "new\nfresh\nlines" } }], usage: { input_tokens: 50, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
      { uuid: "u6", type: "assistant", timestamp: T(6), message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "tool_use", id: "tu_a", name: "Agent", input: { subagent_type: "Explore", prompt: "look around alice's repo" } }], usage: { input_tokens: 40, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
      { uuid: "u7", type: "user", timestamp: T(7), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_a", content: "done" }] }, toolUseResult: { status: "completed", agentId: "beef01", agentType: "Explore", totalTokens: 1234, totalDurationMs: 5000, totalToolUseCount: 3 } },
      { uuid: "u8", type: "assistant", timestamp: T(8), message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "Done." }], usage: { input_tokens: 30, output_tokens: 15, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    ),
  },
  {
    id: "agent-beef01",
    content: jsonl(
      { uuid: "s1", type: "user", timestamp: T(4), isSidechain: true, agentId: "beef01", message: { role: "user", content: "look around alice's repo at /home/alice" } },
      { uuid: "s2", type: "assistant", timestamp: T(5), isSidechain: true, agentId: "beef01", message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "found modules" }], usage: { input_tokens: 200, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    ),
  },
];

function sf(id: string): SourceFile {
  return { path: `/fixtures/${id}.jsonl`, sessionId: id, encodedDir: "-fixtures", isVersion: false, sourceId: SOURCE };
}

/** Ingest a set of {id, content} transcripts into a fresh in-memory DB and derive everything. */
function ingestAll(set: Array<{ id: string; content: string }>) {
  const db = openDb(":memory:");
  const stmts = prepareStatements(db);
  stmts.insAgent.run(AGENT, "Claude Code CLI");
  stmts.insSource.run({ id: SOURCE, label: SOURCE, agent_id: AGENT, config_dir: null });
  const adapter = new ClaudeCodeAdapter();
  const stats = newStats();
  for (const f of set) ingestFile(db, stmts, adapter, sf(f.id), f.content.split("\n"), { size: f.content.length, mtimeMs: 0, hash: f.id }, "2026-01-01T00:00:00.000Z", stats);
  rebuildDerived(db);
  classify(db);
  return db;
}

/** The metric fingerprint that MUST match between raw and redacted ingests. */
function metrics(db: ReturnType<typeof openDb>) {
  const one = (sql: string) => db.prepare(sql).get() as any;
  const tok = one("SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(cache_creation_input_tokens),0) cw, COALESCE(SUM(cache_read_input_tokens),0) cr FROM token_usage");
  let cost = 0;
  for (const r of db.prepare("SELECT model, input_tokens i, output_tokens o, cache_creation_input_tokens cw, cache_read_input_tokens cr FROM token_usage").all() as any[])
    cost += costForUsage(r.model, { input_tokens: r.i, output_tokens: r.o, cache_creation_input_tokens: r.cw, cache_read_input_tokens: r.cr });
  return {
    sessions: one("SELECT COUNT(*) n FROM sessions").n,
    turns: one("SELECT COUNT(*) n FROM turns").n,
    events: one("SELECT COUNT(*) n FROM events").n,
    tool_calls: one("SELECT COUNT(*) n FROM tool_calls").n,
    tokens: tok,
    cost: Number(cost.toFixed(6)),
    linkage: db.prepare("SELECT id, is_sidechain, parent_session_id, parent_turn_id FROM sessions ORDER BY id").all(),
    complexity: db.prepare("SELECT target_id, complexity_score, complexity_band FROM classifications ORDER BY target_id").all(),
  };
}

describe("redactor — metric-preserving oracle (raw vs redacted)", () => {
  let rawM: any, redM: any;
  beforeAll(() => {
    const red = new Redactor("fixed-test-salt");
    const REDACTED = RAW.map((f) => ({ id: f.id, content: red.transcript(f.content) }));
    rawM = metrics(ingestAll(RAW));
    redM = metrics(ingestAll(REDACTED));
  });

  it("token totals and derived cost are identical", () => {
    expect(redM.tokens).toEqual(rawM.tokens);
    expect(redM.cost).toBe(rawM.cost);
  });

  it("session/turn/event/tool_call counts are identical", () => {
    expect(redM.sessions).toBe(rawM.sessions);
    expect(redM.turns).toBe(rawM.turns);
    expect(redM.events).toBe(rawM.events);
    expect(redM.tool_calls).toBe(rawM.tool_calls);
  });

  it("subagent linkage is identical (agentId preserved → spawned_session_id resolves)", () => {
    expect(redM.linkage).toEqual(rawM.linkage);
    const sub = redM.linkage.find((s: any) => s.id === "agent-beef01");
    expect(sub.is_sidechain).toBe(1);
    expect(sub.parent_session_id).toBe("sess-A");
  });

  it("complexity scores are identical (LoC line-counts + file distinctness preserved)", () => {
    expect(redM.complexity).toEqual(rawM.complexity);
  });
});

describe("redactor — leak-free output", () => {
  it("the raw bytes DO leak (so the scan is meaningful), the redacted bytes do NOT", () => {
    const red = new Redactor("fixed-test-salt");
    const redacted = RAW.map((f) => red.transcript(f.content)).join("\n");
    const raw = RAW.map((f) => f.content).join("\n");
    expect(findLeak(raw)).not.toBeNull(); // email + home path + url present in raw
    expect(findLeak(redacted)).toBeNull(); // nothing survives redaction
  });

  it("preserves file extensions while pseudonymizing the path + stripping the username", () => {
    const red = new Redactor("fixed-test-salt");
    const out = red.transcript(RAW[0]!.content);
    expect(out).toContain(".ts"); // extension kept (feeds doc/ops structural signals)
    expect(out).not.toContain("alice"); // username gone
    expect(out).not.toContain("secret-app"); // project name gone
  });

  it("findLeak flags each entity class", () => {
    expect(findLeak("reach me at bob@example.org")!.name).toBe("email");
    expect(findLeak("/home/bob/x")!.name).toBe("home-path-with-user");
    expect(findLeak("/home/user/x")).toBeNull(); // the pseudonym is allowed
  });
});
