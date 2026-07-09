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
import { ClaudeCodeAdapter, parentSessionFromPath, workflowRunFromPath } from "../dist/adapters/claude-code.js";

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
    const sf: SourceFile = { path: file, sessionId: basename(file, ".jsonl"), encodedDir: basename(dirname(file)), isVersion: file.includes("/.versions/"), sourceId: label, parentSessionId: parentSessionFromPath(file), workflowRunId: workflowRunFromPath(file) };
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

  it("session counts: 43 total, 34 main, 9 subagent", () => {
    expect(one("SELECT COUNT(*) n FROM sessions").n).toBe(43);
    expect(one("SELECT COUNT(*) n FROM sessions WHERE is_sidechain=0").n).toBe(34);
    expect(one("SELECT COUNT(*) n FROM sessions WHERE is_sidechain=1").n).toBe(9);
  });

  it("transcript renderers: showcase sessions exercise Bash, Edit/MultiEdit/Write, Plan, and Q&A", () => {
    // sc-bash-0008: four Bash calls (console renderer — $ prompt per command, heredoc/quote-aware).
    expect(one("SELECT COUNT(*) n FROM tool_calls WHERE session_id='sc-bash-0008' AND tool_name='Bash'").n).toBe(4);
    // sc-edit-0009: the colored-diff renderer across all three edit tools.
    expect(one("SELECT COUNT(*) n FROM tool_calls WHERE session_id='sc-edit-0009' AND tool_name='Edit'").n).toBe(1);
    expect(one("SELECT COUNT(*) n FROM tool_calls WHERE session_id='sc-edit-0009' AND tool_name='MultiEdit'").n).toBe(1);
    expect(one("SELECT COUNT(*) n FROM tool_calls WHERE session_id='sc-edit-0009' AND tool_name='Write'").n).toBe(1);
    // sc-plan-0010: the approved-plan card + the AskUserQuestion Q&A card.
    expect(one("SELECT COUNT(*) n FROM tool_calls WHERE session_id='sc-plan-0010' AND tool_name='ExitPlanMode'").n).toBe(1);
    expect(one("SELECT COUNT(*) n FROM tool_calls WHERE session_id='sc-plan-0010' AND tool_name='AskUserQuestion'").n).toBe(1);
  });

  it("skill versioning: api-design fires 3× across 2 content versions; firings link to a version", () => {
    // The sc-skill-0007 scenario fires api-design 3 times: 2 share body v1, 1 has changed body v2.
    expect(one("SELECT COUNT(*) n FROM skills WHERE name='api-design'").n).toBe(2); // content-addressed
    expect(one("SELECT COUNT(*) n FROM tool_calls WHERE skill_name='api-design'").n).toBe(3);
    expect(one("SELECT COUNT(DISTINCT skill_id) n FROM tool_calls WHERE skill_name='api-design'").n).toBe(2);
    // Bodies are normalized (no Base-directory line / ARGUMENTS block) and carry a summary.
    const v = one("SELECT body, summary FROM skills WHERE name='api-design' ORDER BY last_seen LIMIT 1");
    expect(v.summary).toBe("API Design");
    expect(v.body).not.toContain("Base directory");
    expect(v.body).not.toContain("ARGUMENTS");
  });

  it("subagents: all 9 link to a parent (Task via toolUseResult + workflow via run id), none orphaned", () => {
    expect(one("SELECT COUNT(*) n FROM sessions WHERE is_sidechain=1 AND parent_session_id IS NOT NULL").n).toBe(9);
    expect(one("SELECT COUNT(*) n FROM sessions WHERE is_sidechain=1 AND parent_session_id IS NULL").n).toBe(0);
    expect(one("SELECT COUNT(*) n FROM sessions WHERE parent_session_id='sc-workflow-0003'").n).toBe(2);
  });

  it("workflow run: agents carry the run id and link to the launching turn", () => {
    // Both wf agents share the run id captured from their path...
    expect(one("SELECT COUNT(*) n FROM sessions WHERE workflow_run_id='wf_demo000abc'").n).toBe(2);
    // ...and the launching Workflow tool_call captured the same run id + name from its result, so the
    // agents now resolve a parent_turn_id (not just a parent_session_id).
    const tc = one("SELECT workflow_run_id, workflow_name FROM tool_calls WHERE session_id='sc-workflow-0003' AND tool_name='Workflow'");
    expect(tc.workflow_run_id).toBe("wf_demo000abc");
    expect(tc.workflow_name).toBe("migrate-db");
    expect(one("SELECT COUNT(*) n FROM sessions WHERE workflow_run_id='wf_demo000abc' AND parent_turn_id IS NOT NULL").n).toBe(2);
  });

  it("slash command: a /plugin-only session ingests as user turns with no assistant output", () => {
    expect(one("SELECT turn_count n FROM sessions WHERE id='sc-command-0006'").n).toBe(2);
    expect(one("SELECT COUNT(*) n FROM events WHERE session_id='sc-command-0006' AND role='assistant'").n).toBe(0);
    expect(one("SELECT COUNT(*) n FROM events WHERE session_id='sc-command-0006' AND text LIKE '%<command-name>/plugin%'").n).toBe(1);
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
