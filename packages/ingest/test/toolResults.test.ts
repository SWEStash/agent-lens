/**
 * Spilled tool-result ingest (toolResults.ts) — proves tool-results/<name>.txt is captured into a
 * tool_results row keyed by (session_id, name) with its full text + byte size, honoring exclusion and
 * the idempotent skip. Imports the BUILT dist (matches the other suites).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { SCHEMA_SQL, encodeProjectPath } from "@agent-lens/core";
import { ingestToolResults, newToolResultStats } from "../dist/toolResults.js";

const ENC = encodeProjectPath("/home/u/proj");
let root: string;
let archive: string; // the per-source archive dir (…/<source>)

function writeResult(sessionId: string, name: string, text: string) {
  const dir = join(archive, "projects", ENC, sessionId, "tool-results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.txt`), text);
}

function db() {
  const d = new Database(":memory:");
  d.exec(SCHEMA_SQL);
  return d;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "al-tr."));
  archive = join(root, "isf");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ingestToolResults", () => {
  it("captures a spilled file into a tool_results row keyed by (session_id, name)", () => {
    writeResult("sess1", "bk7e5i18g", "line one\nline two\nfull untruncated output");
    const d = db();
    const stats = newToolResultStats();
    ingestToolResults(d, archive, [], "2026-07-05T00:00:00Z", stats, true);
    expect(stats.upserted).toBe(1);

    const row = d.prepare("SELECT * FROM tool_results WHERE session_id = 'sess1' AND name = 'bk7e5i18g'").get() as any;
    expect(row.text).toContain("full untruncated output");
    expect(row.bytes).toBe(Buffer.byteLength("line one\nline two\nfull untruncated output"));
    expect(row.path).toContain("tool-results/bk7e5i18g.txt");
  });

  it("also handles toolu_<id>.txt naming (older builds)", () => {
    writeResult("sess2", "toolu_01abc", "x");
    const d = db();
    ingestToolResults(d, archive, [], "t", newToolResultStats(), true);
    const row = d.prepare("SELECT name FROM tool_results WHERE session_id = 'sess2'").get() as any;
    expect(row.name).toBe("toolu_01abc");
  });

  it("skips excluded projects and is idempotent on re-run", () => {
    writeResult("sess1", "bk7e5i18g", "out");
    const d = db();
    // Excluded → nothing ingested.
    ingestToolResults(d, archive, [ENC], "t", newToolResultStats(), true);
    expect(d.prepare("SELECT COUNT(*) n FROM tool_results").get() as any).toEqual({ n: 0 });

    // Not excluded → ingested once, then skipped on the next (incremental) run.
    const s2 = newToolResultStats();
    ingestToolResults(d, archive, [], "t", s2, false);
    expect(s2.upserted).toBe(1);
    const s3 = newToolResultStats();
    ingestToolResults(d, archive, [], "t", s3, false);
    expect(s3.upserted).toBe(0);
    expect(s3.skipped).toBe(1);
  });
});
