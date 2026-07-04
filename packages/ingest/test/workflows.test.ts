/**
 * Workflow result sidecar ingest (workflows.ts) — proves the runner's wf_<id>.json sidecar is parsed
 * into a workflow_results row: status/summary/result, the roll-up scalars, epoch→ISO time + derived
 * end time, doubly-projected JSON columns (phases/logs), ANSI-stripped model, launching session from
 * the path, exclusion, and the idempotent skip. Imports the BUILT dist (matches the other suites).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { SCHEMA_SQL, encodeProjectPath } from "@agent-lens/core";
import { ingestWorkflowResults, newWorkflowStats } from "../dist/workflows.js";

const ENC = encodeProjectPath("/home/u/proj");
let root: string;
let archive: string; // the per-source archive dir (…/<source>)

function writeSidecar(sessionId: string, runId: string, body: unknown) {
  const dir = join(archive, "projects", ENC, sessionId, "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.json`), JSON.stringify(body));
}

function db() {
  const d = new Database(":memory:");
  d.exec(SCHEMA_SQL);
  return d;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "al-wf."));
  archive = join(root, "isf");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ingestWorkflowResults", () => {
  it("parses a completed sidecar into a workflow_results row", () => {
    writeSidecar("sess1", "wf_abc", {
      runId: "wf_abc",
      taskId: "task9",
      workflowName: "skill-evals",
      status: "completed",
      summary: "ran the evals",
      defaultModel: "claude-fable-5[1m", // ANSI escape leaks in from the runner
      startTime: 1783075565365,
      durationMs: 5000,
      agentCount: 12,
      totalTokens: 500,
      totalToolCalls: 24,
      result: { results: [{ skill: "a", n: 5, red: 3, green: 5 }], total: { red: 3, green: 5, n: 5 } },
      phases: [{ title: "Generate" }, { title: "Judge" }],
      logs: ["a: RED 3/5 GREEN 5/5"],
      workflowProgress: [{ type: "workflow_phase", index: 1, title: "Generate" }],
      script: "SHOULD NOT BE STORED",
      args: "SHOULD NOT BE STORED",
    });
    const d = db();
    const stats = newWorkflowStats();
    ingestWorkflowResults(d, archive, "isf", [], "2026-07-04T00:00:00Z", stats, true);
    expect(stats.upserted).toBe(1);

    const row = d.prepare("SELECT * FROM workflow_results WHERE run_id = 'wf_abc'").get() as any;
    expect(row.status).toBe("completed");
    expect(row.session_id).toBe("sess1");
    expect(row.source_id).toBe("isf");
    expect(row.task_id).toBe("task9");
    expect(row.default_model).toBe("claude-fable-5"); // ANSI stripped
    expect(row.agent_count).toBe(12);
    expect(row.total_tool_calls).toBe(24);
    expect(row.started_at).toBe(new Date(1783075565365).toISOString());
    expect(row.ended_at).toBe(new Date(1783075565365 + 5000).toISOString());
    expect(JSON.parse(row.result_json).total.green).toBe(5);
    expect(JSON.parse(row.phases_json).map((p: any) => p.title)).toEqual(["Generate", "Judge"]);
    expect(JSON.parse(row.logs_json)).toEqual(["a: RED 3/5 GREEN 5/5"]);
    // The bulky launch payload is NOT re-stored (it already lives on the Workflow tool_call).
    expect(row.result_json).not.toContain("SHOULD NOT BE STORED");
  });

  it("captures a failed run with no agents", () => {
    writeSidecar("sess2", "wf_bad", { runId: "wf_bad", status: "failed", agentCount: 0, durationMs: 76, result: null });
    const d = db();
    ingestWorkflowResults(d, archive, "isf", [], "2026-07-04T00:00:00Z", newWorkflowStats(), true);
    const row = d.prepare("SELECT status, agent_count, result_json FROM workflow_results WHERE run_id = 'wf_bad'").get() as any;
    expect(row.status).toBe("failed");
    expect(row.agent_count).toBe(0);
    expect(row.result_json).toBeNull();
  });

  it("skips excluded projects and is idempotent on re-run", () => {
    writeSidecar("sess1", "wf_abc", { runId: "wf_abc", status: "completed" });
    const d = db();
    // Excluded → nothing ingested.
    const s1 = newWorkflowStats();
    ingestWorkflowResults(d, archive, "isf", [ENC], "t", s1, true);
    expect(d.prepare("SELECT COUNT(*) n FROM workflow_results").get() as any).toEqual({ n: 0 });

    // Not excluded → ingested once, then skipped on the next (incremental) run.
    const s2 = newWorkflowStats();
    ingestWorkflowResults(d, archive, "isf", [], "t", s2, false);
    expect(s2.upserted).toBe(1);
    const s3 = newWorkflowStats();
    ingestWorkflowResults(d, archive, "isf", [], "t", s3, false);
    expect(s3.upserted).toBe(0);
    expect(s3.skipped).toBe(1);
  });
});
