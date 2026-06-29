/**
 * Corpus scenario coverage (validation Layer 4/5, in CI). Ingests the committed 3-source corpus
 * (team-a, team-b = redacted real; scenarios = synthetic) through the real engine and asserts every
 * scenario the corpus is meant to represent — so `pnpm test` guards end-to-end scenario coverage, not
 * just the manual sandbox. Per-scenario unit correctness lives in ingest.test.ts/classify.test.ts;
 * this checks they all hold together over the real committed fixture.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, relative } from "node:path";
import type { SourceFile } from "@agent-lens/core";
import { openDb } from "../dist/db.js";
import { prepareStatements, ingestFile, rebuildDerived, newStats } from "../dist/pipeline.js";
import { classify } from "../dist/classify.js";
import { ClaudeCodeAdapter } from "../dist/adapters/claude-code.js";

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures/corpus");

function listJsonl(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listJsonl(p));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out.sort();
}

let db: ReturnType<typeof openDb>;
let malformed = 0;

beforeAll(() => {
  db = openDb(":memory:");
  const stmts = prepareStatements(db);
  stmts.insAgent.run("claude-code", "Claude Code CLI");
  const adapter = new ClaudeCodeAdapter();
  const stats = newStats();
  const labels = new Set<string>();
  for (const file of listJsonl(CORPUS)) {
    const label = relative(CORPUS, file).split("/")[0]!; // team-a | team-b | scenarios
    if (!labels.has(label)) {
      stmts.insSource.run({ id: label, label, agent_id: "claude-code", config_dir: null });
      labels.add(label);
    }
    const sf: SourceFile = { path: file, sessionId: basename(file, ".jsonl"), encodedDir: basename(dirname(file)), isVersion: file.includes("/.versions/"), sourceId: label };
    const content = readFileSync(file, "utf8");
    ingestFile(db, stmts, adapter, sf, content.split("\n"), { size: statSync(file).size, mtimeMs: 0, hash: file }, "2026-01-01T00:00:00.000Z", stats);
  }
  rebuildDerived(db);
  classify(db);
  malformed = stats.malformed;
});

const one = (sql: string) => db.prepare(sql).get() as any;

describe("committed corpus represents every pipeline scenario", () => {
  it("multi-source: three labeled sources, no cross-source bleed", () => {
    expect(one("SELECT COUNT(DISTINCT source_id) n FROM sessions").n).toBe(3);
    // Each session's source matches the events ingested under it (no bleed).
    expect(one("SELECT COUNT(*) n FROM sessions WHERE source_id NOT IN ('team-a','team-b','scenarios')").n).toBe(0);
  });

  it("session counts: 12 total, 7 main, 5 subagent", () => {
    expect(one("SELECT COUNT(*) n FROM sessions").n).toBe(12);
    expect(one("SELECT COUNT(*) n FROM sessions WHERE is_sidechain=0").n).toBe(7);
    expect(one("SELECT COUNT(*) n FROM sessions WHERE is_sidechain=1").n).toBe(5);
  });

  it("subagents: 3 linked (Task), 2 orphan (workflow fan-out)", () => {
    expect(one("SELECT COUNT(*) n FROM sessions WHERE is_sidechain=1 AND parent_session_id IS NOT NULL").n).toBe(3);
    expect(one("SELECT COUNT(*) n FROM sessions WHERE is_sidechain=1 AND parent_session_id IS NULL").n).toBe(2);
  });

  it("no double-count: a Task child's tokens stay in the child session", () => {
    expect(one("SELECT SUM(input_tokens) i FROM token_usage WHERE session_id='agent-c0ffee01'").i).toBe(1500);
    expect(one("SELECT SUM(input_tokens) i FROM token_usage WHERE session_id='sc-sub-parent-0002'").i).toBe(1300);
  });

  it("compaction: an isMeta summary line creates no turn", () => {
    expect(one("SELECT turn_count n FROM sessions WHERE id='sc-plain-0001'").n).toBe(2);
  });

  it("dedup: a uuid in mirror + .versions is stored once (version-only event kept)", () => {
    expect(one("SELECT event_count n FROM sessions WHERE id='sc-resumed-0005'").n).toBe(3);
  });

  it("cache tokens: read and creation are both tracked", () => {
    const r = one("SELECT SUM(cache_read_input_tokens) cr, SUM(cache_creation_input_tokens) cw FROM token_usage");
    expect(r.cr).toBeGreaterThan(0);
    expect(r.cw).toBeGreaterThan(0);
  });

  it("malformed: the truncated line was counted, not silently dropped", () => {
    expect(malformed).toBe(1);
  });
});
