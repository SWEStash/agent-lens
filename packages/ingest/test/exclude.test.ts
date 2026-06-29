/**
 * Project exclusion (global feature) — keep playground/personal/dummy projects out of Agent Lens.
 * Covers the path encoder/matchers used at every stage (collect, ingest, corpus) and the DB prune
 * that makes adding a project to the exclude list drop its data (and its subagents) on next ingest.
 *
 * Imports the BUILT dist.
 */
import { describe, it, expect } from "vitest";
import { encodeProjectPath, parseExcludes, isExcludedDir, isExcludedArchivePath } from "../dist/redact.js";
import { openDb } from "../dist/db.js";
import { prepareStatements, ingestFile, rebuildDerived, pruneExcluded, newStats } from "../dist/pipeline.js";
import { classify } from "../dist/classify.js";
import { ClaudeCodeAdapter } from "../dist/adapters/claude-code.js";
import type { SourceFile } from "@agent-lens/core";

const T = (n: number) => `2026-01-01T00:0${n}:00.000Z`;
const jsonl = (...l: unknown[]) => l.map((x) => JSON.stringify(x)).join("\n") + "\n";

describe("path encoding + exclusion matchers", () => {
  it("encodes a real cwd to its projects/<encodedDir> name ('/' and '.' → '-')", () => {
    expect(encodeProjectPath("/home/m4pre/git-projects/swestash/agent-lens")).toBe("-home-m4pre-git-projects-swestash-agent-lens");
    expect(encodeProjectPath("/home/u/proj/")).toBe("-home-u-proj"); // trailing separator dropped
    expect(encodeProjectPath("/home/u/.config/app")).toBe("-home-u--config-app");
  });

  it("parseExcludes splits CSV and encodes each entry", () => {
    expect(parseExcludes(" /a/b , ,/c/d ")).toEqual(["-a-b", "-c-d"]);
    expect(parseExcludes("")).toEqual([]);
    expect(parseExcludes(undefined)).toEqual([]);
  });

  it("isExcludedDir matches exact dir or a nested project under it", () => {
    const ex = parseExcludes("/home/u/proj");
    expect(isExcludedDir("-home-u-proj", ex)).toBe(true);
    expect(isExcludedDir("-home-u-proj-sub", ex)).toBe(true);
    expect(isExcludedDir("-home-u-other", ex)).toBe(false);
  });

  it("isExcludedArchivePath matches the main file AND nested subagent files", () => {
    const ex = parseExcludes("/home/u/proj");
    expect(isExcludedArchivePath("/d/archive/x/projects/-home-u-proj/abc.jsonl", ex)).toBe(true);
    expect(isExcludedArchivePath("/d/archive/x/projects/-home-u-proj/UUID/subagents/agent-1.jsonl", ex)).toBe(true);
    expect(isExcludedArchivePath("/d/archive/x/projects/-home-u-other/abc.jsonl", ex)).toBe(false);
  });
});

describe("pruneExcluded removes an excluded project's sessions (and subagents)", () => {
  function sf(id: string): SourceFile {
    return { path: `/fixtures/${id}.jsonl`, sessionId: id, encodedDir: "-fixtures", isVersion: false, sourceId: "test" };
  }
  function build() {
    const db = openDb(":memory:");
    const stmts = prepareStatements(db);
    stmts.insAgent.run("claude-code", "Claude Code CLI");
    stmts.insSource.run({ id: "test", label: "test", agent_id: "claude-code", config_dir: null });
    const adapter = new ClaudeCodeAdapter();
    const stats = newStats();
    // Project we keep.
    const keep = sf("keep-main");
    ingestFile(db, stmts, adapter, keep, jsonl(
      { uuid: "k1", type: "user", timestamp: T(1), cwd: "/home/u/proj-keep", message: { role: "user", content: "keep me" } },
      { uuid: "k2", type: "assistant", timestamp: T(2), message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    ).split("\n"), { size: 1, mtimeMs: 0, hash: "k" }, T(1), stats);
    // Project we drop — a main that spawns a subagent (the subagent has NO cwd → pruned only via linkage).
    const drop = sf("drop-main");
    ingestFile(db, stmts, adapter, drop, jsonl(
      { uuid: "d1", type: "user", timestamp: T(1), cwd: "/home/u/proj-drop", message: { role: "user", content: "drop me" } },
      { uuid: "d2", type: "assistant", timestamp: T(2), message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "tool_use", id: "tu", name: "Agent", input: { subagent_type: "Explore" } }], usage: { input_tokens: 9, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
      { uuid: "d3", type: "user", timestamp: T(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu", content: "done" }] }, toolUseResult: { status: "completed", agentId: "dropsub", agentType: "Explore" } },
    ).split("\n"), { size: 1, mtimeMs: 0, hash: "d" }, T(1), stats);
    ingestFile(db, stmts, adapter, sf("agent-dropsub"), jsonl(
      { uuid: "s1", type: "user", timestamp: T(2), isSidechain: true, agentId: "dropsub", message: { role: "user", content: "sub work" } },
      { uuid: "s2", type: "assistant", timestamp: T(3), isSidechain: true, agentId: "dropsub", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "found" }], usage: { input_tokens: 7, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    ).split("\n"), { size: 1, mtimeMs: 0, hash: "s" }, T(1), stats);
    rebuildDerived(db);
    classify(db);
    return db;
  }

  it("drops the excluded project + its subagent, keeps the rest, and removes dependent rows", () => {
    const db = build();
    expect((db.prepare("SELECT COUNT(*) n FROM sessions").get() as any).n).toBe(3);
    // Sanity: the subagent linked to drop-main.
    expect((db.prepare("SELECT parent_session_id p FROM sessions WHERE id='agent-dropsub'").get() as any).p).toBe("drop-main");

    const pruned = pruneExcluded(db, ["/home/u/proj-drop"]);
    expect(pruned).toBe(2); // drop-main + its subagent (pulled in transitively)

    const ids = (db.prepare("SELECT id FROM sessions ORDER BY id").all() as any[]).map((r) => r.id);
    expect(ids).toEqual(["keep-main"]);
    // Dependent rows for the dropped sessions are gone.
    for (const tbl of ["events", "token_usage", "tool_calls", "turns"]) {
      const n = (db.prepare(`SELECT COUNT(*) n FROM ${tbl} WHERE session_id IN ('drop-main','agent-dropsub')`).get() as any).n;
      expect(n).toBe(0);
    }
    expect((db.prepare("SELECT COUNT(*) n FROM classifications WHERE target_id IN ('drop-main','agent-dropsub')").get() as any).n).toBe(0);
    // The kept project is fully intact.
    expect((db.prepare("SELECT COUNT(*) n FROM events WHERE session_id='keep-main'").get() as any).n).toBe(2);
    expect((db.prepare("SELECT SUM(input_tokens) i FROM token_usage WHERE session_id='keep-main'").get() as any).i).toBe(5);
  });

  it("is a no-op when nothing matches", () => {
    const db = build();
    expect(pruneExcluded(db, ["/home/u/nonexistent"])).toBe(0);
    expect((db.prepare("SELECT COUNT(*) n FROM sessions").get() as any).n).toBe(3);
  });
});
