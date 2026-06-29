/**
 * Classifier formulas (ADR-004) — `complexity` and `scoreCategories` are not exported, so we drive
 * the real `classify()` over a directly-seeded DB and read the materialized score/band/category plus
 * the `signals_json` sub-scores. `locDelta` IS exported and unit-tested directly. Foreign keys are
 * left OFF in these DBs: we are testing the deterministic derivation over sessions/tool_calls/
 * token_usage/turns, not referential integrity (that's covered by the ingest golden test).
 *
 * Imports the BUILT dist so it exercises exactly what ships.
 */
import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "@agent-lens/core";
import { classify, locDelta } from "../dist/classify.js";

describe("locDelta — LoC parsed from a tool call's verbatim input", () => {
  it("Write counts content lines as added (no removed); trailing newline doesn't add a line", () => {
    expect(locDelta("Write", JSON.stringify({ file_path: "/p/a.ts", content: "l1\nl2\nl3" }))).toEqual({ added: 3, removed: 0, file: "/p/a.ts" });
    expect(locDelta("Write", JSON.stringify({ file_path: "/p/a.ts", content: "l1\nl2\n" }))).toEqual({ added: 2, removed: 0, file: "/p/a.ts" });
  });

  it("Edit counts new_string as added and old_string as removed", () => {
    expect(locDelta("Edit", JSON.stringify({ file_path: "/p/b.ts", old_string: "a\nb", new_string: "x\ny\nz" }))).toEqual({ added: 3, removed: 2, file: "/p/b.ts" });
  });

  it("returns zero for empty content, null input, or unparseable JSON", () => {
    expect(locDelta("Write", JSON.stringify({ file_path: "/p/c.ts", content: "" }))).toEqual({ added: 0, removed: 0, file: "/p/c.ts" });
    expect(locDelta("Write", null)).toEqual({ added: 0, removed: 0, file: null });
    expect(locDelta("Edit", "{not json")).toEqual({ added: 0, removed: 0, file: null });
  });

  it("a non-edit tool contributes no LoC", () => {
    expect(locDelta("Bash", JSON.stringify({ command: "ls" }))).toEqual({ added: 0, removed: 0, file: null });
  });
});

// ---- Complexity formula (weighted, with v2 ceilings) ----

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.pragma("foreign_keys = OFF"); // seed only what the classifier reads, not the full FK graph
  return db;
}

function addSession(db: Database.Database, id: string, opts: { sidechain?: number; turns?: number; durationMs?: number } = {}) {
  db.prepare(
    `INSERT INTO sessions (id, agent_id, is_sidechain, duration_ms, event_count, turn_count) VALUES (?, 'claude-code', ?, ?, 0, ?)`,
  ).run(id, opts.sidechain ?? 0, opts.durationMs ?? null, opts.turns ?? 0);
}
function addTool(db: Database.Database, id: string, session: string, tool: string, extra: { input?: any; agentType?: string; spawned?: string } = {}) {
  db.prepare(
    `INSERT INTO tool_calls (id, session_id, tool_name, agent_type, spawned_session_id, input_json) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, session, tool, extra.agentType ?? null, extra.spawned ?? null, extra.input != null ? JSON.stringify(extra.input) : null);
}
function addTokens(db: Database.Database, session: string, ev: string, u: { i?: number; o?: number; cw?: number; cr?: number }) {
  db.prepare(
    `INSERT INTO token_usage (event_uuid, session_id, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(ev, session, u.i ?? 0, u.o ?? 0, u.cw ?? 0, u.cr ?? 0);
}
function addTurn(db: Database.Database, session: string, seq: number, prompt: string) {
  db.prepare(`INSERT INTO turns (id, session_id, seq, prompt_preview) VALUES (?, ?, ?, ?)`).run(`${session}:${seq}`, session, seq, prompt);
}
const signalsOf = (db: Database.Database, id: string) =>
  JSON.parse((db.prepare("SELECT signals_json FROM classifications WHERE target_id = ?").get(id) as any).signals_json);
const classOf = (db: Database.Database, id: string) =>
  db.prepare("SELECT category, complexity_score, complexity_band FROM classifications WHERE target_id = ?").get(id) as any;

describe("complexity — weighted sub-scores with v2 ceilings", () => {
  it("a session with no signal scores 0 / trivial", () => {
    const db = freshDb();
    addSession(db, "zero");
    classify(db);
    const c = classOf(db, "zero");
    expect(c.complexity_score).toBe(0);
    expect(c.complexity_band).toBe("trivial");
  });

  it("every sub-score clamps to 1.0 at its ceiling → score 100.0 / xl (proves weights sum to 1)", () => {
    const db = freshDb();
    addSession(db, "max", { turns: 40, durationMs: 600 * 60_000 }); // turns & duration ceilings
    addTokens(db, "max", "max-e", { i: 40_000_000 }); // work-tokens ceiling
    addTool(db, "max-w", "max", "Write", { input: { file_path: "/p/f0.ts", content: Array(6000).fill("x").join("\n") } }); // loc churn ceiling
    for (let i = 1; i < 40; i++) addTool(db, `max-e${i}`, "max", "Edit", { input: { file_path: `/p/f${i}.ts`, old_string: "", new_string: "" } }); // 40 distinct files
    for (let i = 0; i < 10; i++) addTool(db, `max-a${i}`, "max", "Agent", { agentType: "general-purpose" }); // subagent ceiling
    classify(db);
    const s = signalsOf(db, "max");
    expect(s.complexity_subscores).toEqual({ loc: 1, files: 1, turns: 1, tokens: 1, duration: 1, subagents: 1 });
    const c = classOf(db, "max");
    expect(c.complexity_score).toBe(100);
    expect(c.complexity_band).toBe("xl");
  });

  it("linear sub-scores (files/turns/duration/subagents) compute exactly at half-ceiling", () => {
    const db = freshDb();
    addSession(db, "half", { turns: 20, durationMs: 300 * 60_000 }); // turns 0.5, duration 0.5
    for (let i = 0; i < 20; i++) addTool(db, `h-e${i}`, "half", "Edit", { input: { file_path: `/p/g${i}.ts`, old_string: "", new_string: "" } }); // files 20/40 = 0.5, churn 0
    for (let i = 0; i < 5; i++) addTool(db, `h-a${i}`, "half", "Agent", { agentType: "Explore" }); // subagents 5/10 = 0.5
    classify(db);
    const s = signalsOf(db, "half");
    expect(s.complexity_subscores.files).toBeCloseTo(0.5, 10);
    expect(s.complexity_subscores.turns).toBeCloseTo(0.5, 10);
    expect(s.complexity_subscores.duration).toBeCloseTo(0.5, 10);
    expect(s.complexity_subscores.subagents).toBeCloseTo(0.5, 10);
    expect(s.complexity_subscores.loc).toBe(0); // log1p(0) = 0
    expect(s.complexity_subscores.tokens).toBe(0);
    // score = 0.15*0.5 + 0.2*0.5 + 0.1*0.5 + 0.1*0.5 = 0.275 → 27.5; band "small" (>=22, <40)
    expect(classOf(db, "half").complexity_score).toBeCloseTo(27.5, 10);
    expect(classOf(db, "half").complexity_band).toBe("small");
  });

  it("work-tokens excludes cache-read (replay ≠ work)", () => {
    const db = freshDb();
    addSession(db, "cache");
    addTokens(db, "cache", "c-e", { i: 100, o: 50, cw: 25, cr: 999_999_999 }); // huge cache-read
    classify(db);
    const s = signalsOf(db, "cache");
    expect(s.work_tokens).toBe(175); // 100 + 50 + 25, cache-read NOT folded in
    expect(s.cache_read_tokens).toBe(999_999_999);
  });
});

describe("category — keyword + structural evidence, with subagent-role override", () => {
  let db: Database.Database;
  beforeAll(() => {
    db = freshDb();
    const cases: Array<[string, string]> = [
      ["bug", "fix the broken bug and the crash"],
      ["doc", "update the readme and documentation"],
      ["ops", "fix the docker deploy pipeline"],
      ["ref", "refactor and clean up, then rename the module"],
      ["rev", "please review and audit the code"],
      ["feat", "implement a new feature for users"],
    ];
    for (const [id, prompt] of cases) {
      addSession(db, id, { turns: 1 });
      addTurn(db, id, 0, prompt);
    }
    // Read-dominated session with no keywords → structural "review".
    addSession(db, "readonly", { turns: 1 });
    addTurn(db, "readonly", 0, "take a look at this");
    for (let i = 0; i < 6; i++) addTool(db, `ro-r${i}`, "readonly", "Read");
    // Subagent spawned as Explore — role overrides keyword heuristics → "review".
    addSession(db, "agent-x", { sidechain: 1, turns: 1 });
    addTurn(db, "agent-x", 0, "implement a new feature"); // would be 'feature' by keywords
    addTool(db, "spawn-x", "feat", "Agent", { agentType: "Explore", spawned: "agent-x" });
    classify(db);
  });

  it("keyword evidence picks the dominant category", () => {
    expect(classOf(db, "bug").category).toBe("bugfix");
    expect(classOf(db, "doc").category).toBe("docs");
    expect(classOf(db, "ops").category).toBe("ops");
    expect(classOf(db, "ref").category).toBe("refactor");
    expect(classOf(db, "rev").category).toBe("review");
    expect(classOf(db, "feat").category).toBe("feature");
  });

  it("a read-dominated session with no keywords classifies as review (structural)", () => {
    expect(classOf(db, "readonly").category).toBe("review");
  });

  it("a subagent's category comes from its spawner role, not its own transcript keywords", () => {
    expect(classOf(db, "agent-x").category).toBe("review"); // Explore → review, despite 'feature' prompt
  });
});
