/**
 * Subagent metadata sidecar ingest (meta.ts) — proves subagents/agent-<id>.meta.json is parsed into a
 * session_meta row keyed by the filename stem (= the subagent's session id), with agentType/description/
 * spawnDepth (spawnDepth optional), source, exclusion, and the idempotent skip. Imports the BUILT dist
 * (matches the other suites).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { SCHEMA_SQL, encodeProjectPath } from "@agent-lens/core";
import { ingestSubagentMeta, newMetaStats } from "../dist/meta.js";

const ENC = encodeProjectPath("/home/u/proj");
let root: string;
let archive: string; // the per-source archive dir (…/<source>)

function writeMeta(sessionId: string, agentId: string, body: unknown) {
  const dir = join(archive, "projects", ENC, sessionId, "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${agentId}.meta.json`), JSON.stringify(body));
}

function db() {
  const d = new Database(":memory:");
  d.exec(SCHEMA_SQL);
  return d;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "al-meta."));
  archive = join(root, "isf");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ingestSubagentMeta", () => {
  it("parses a meta sidecar into a session_meta row keyed by the agent-<id> stem", () => {
    writeMeta("sess1", "agent-abc123", {
      agentType: "Explore",
      description: "Explore the ingest pipeline",
      toolUseId: "toolu_01xyz",
      spawnDepth: 2,
    });
    const d = db();
    const stats = newMetaStats();
    ingestSubagentMeta(d, archive, "isf", [], "2026-07-05T00:00:00Z", stats, true);
    expect(stats.upserted).toBe(1);

    const row = d.prepare("SELECT * FROM session_meta WHERE session_id = 'agent-abc123'").get() as any;
    expect(row.agent_type).toBe("Explore");
    expect(row.agent_description).toBe("Explore the ingest pipeline");
    expect(row.tool_use_id).toBe("toolu_01xyz");
    expect(row.spawn_depth).toBe(2);
    expect(row.source_id).toBe("isf");
  });

  it("handles a meta sidecar with no spawnDepth (top-level launch)", () => {
    writeMeta("sess2", "agent-def456", { agentType: "claude-code-guide", description: "Research crash", toolUseId: "toolu_02" });
    const d = db();
    ingestSubagentMeta(d, archive, "isf", [], "t", newMetaStats(), true);
    const row = d.prepare("SELECT agent_type, spawn_depth FROM session_meta WHERE session_id = 'agent-def456'").get() as any;
    expect(row.agent_type).toBe("claude-code-guide");
    expect(row.spawn_depth).toBeNull();
  });

  it("skips excluded projects and is idempotent on re-run", () => {
    writeMeta("sess1", "agent-abc123", { agentType: "Explore", description: "x", toolUseId: "toolu_1" });
    const d = db();
    // Excluded → nothing ingested.
    ingestSubagentMeta(d, archive, "isf", [ENC], "t", newMetaStats(), true);
    expect(d.prepare("SELECT COUNT(*) n FROM session_meta").get() as any).toEqual({ n: 0 });

    // Not excluded → ingested once, then skipped on the next (incremental) run.
    const s2 = newMetaStats();
    ingestSubagentMeta(d, archive, "isf", [], "t", s2, false);
    expect(s2.upserted).toBe(1);
    const s3 = newMetaStats();
    ingestSubagentMeta(d, archive, "isf", [], "t", s3, false);
    expect(s3.upserted).toBe(0);
    expect(s3.skipped).toBe(1);
  });
});
