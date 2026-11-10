/**
 * Pipeline determinism (validation Layer 3), over the committed redacted corpus:
 *   - FULL == INCREMENTAL: a one-shot full rebuild and a chunked incremental ingest (mains first,
 *     subagents second — the realistic split) must yield byte-identical derived state. This guards
 *     the entire incremental-rebuild + linkage-expansion machinery (ADR-010).
 *   - IDEMPOTENT: re-ingesting unchanged files adds zero events and changes no derived row.
 *
 * Imports the BUILT dist. The corpus is real data, redacted to be metric-faithful (see Layer 4).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import type { SourceFile } from "@agent-lens/core";
import { openDb } from "../dist/db.js";
import { prepareStatements, ingestFile, rebuildDerived, newStats } from "../dist/pipeline.js";
import { classify } from "../dist/classify.js";
import { detect } from "../dist/detect.js";
import { deriveFileChanges } from "../dist/filechanges.js";
import { ClaudeCodeAdapter } from "../dist/adapters/claude-code.js";
import { compareIngestOrder, contentSpan } from "../dist/ingestorder.js";
import { listJsonl } from "./helpers/seed.js";

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures/corpus");

/** The corpus in the order a real run ingests it (ADR-038): the order decides which session owns
 * history that two sessions share, so a test that used path order would test a different store. */
const inIngestOrder = (files: string[]) =>
  files
    .map((path) => ({ path, isVersion: path.includes("/.versions/"), span: contentSpan(path) }))
    .sort(compareIngestOrder)
    .map((f) => f.path);

const allFiles = inIngestOrder(listJsonl(CORPUS));
const toSF = (file: string): SourceFile => ({ path: file, sessionId: basename(file, ".jsonl"), encodedDir: basename(dirname(file)), isVersion: false, sourceId: "x" });

function newDb() {
  const db = openDb(":memory:");
  const stmts = prepareStatements(db);
  stmts.insAgent.run("claude-code", "Claude Code CLI");
  stmts.insSource.run({ id: "x", label: "x", agent_id: "claude-code", config_dir: null });
  return { db, stmts, adapter: new ClaudeCodeAdapter() };
}
function ingest(db: any, stmts: any, adapter: any, files: string[], stats = newStats()) {
  for (const f of files) {
    const c = readFileSync(f, "utf8");
    ingestFile(db, stmts, adapter, toSF(f), c.split("\n"), { size: statSync(f).size, mtimeMs: 0, hash: basename(f) }, "2026-01-01T00:00:00.000Z", stats);
  }
  return stats;
}
const sessionIdsOf = (files: string[]) => new Set(files.map((f) => basename(f, ".jsonl")));

/** A stable snapshot of ALL derived state — what determinism must reproduce exactly. */
function snapshot(db: any): string {
  const dump = (sql: string) => JSON.stringify(db.prepare(sql).all());
  return [
    dump("SELECT id, is_sidechain, parent_session_id, parent_turn_id, continued_from_session_id, event_count, turn_count, duration_ms FROM sessions ORDER BY id"),
    dump("SELECT id, session_id, seq, model FROM turns ORDER BY id"),
    dump("SELECT target_id, category, complexity_score, complexity_band FROM classifications ORDER BY target_id"),
    dump("SELECT event_uuid, turn_id FROM token_usage ORDER BY event_uuid"),
    dump("SELECT id, session_id, turn_id, tool_name, spawned_session_id FROM tool_calls ORDER BY id"),
    dump("SELECT id, session_id, tool_call_id, rule_id, category, severity FROM findings ORDER BY id"),
    dump("SELECT id, session_id, tool_call_id, file_path, tool_name, lines_added, lines_removed FROM file_changes ORDER BY id"),
  ].join("\n");
}

/**
 * What must hold for any store, checked here on every CI run rather than only by `pnpm validate`
 * against a real store (validation Layer 2). The double-count behind the 2026-11-04 outage broke the
 * second and third for months before anything crashed (ADR-038).
 */
function ownershipViolations(db: any): Record<string, number> {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    foreignKeys: db.prepare("PRAGMA foreign_key_check").all().length,
    responsesInTwoSessions: n(
      "SELECT COUNT(*) n FROM (SELECT message_id FROM token_usage WHERE message_id IS NOT NULL GROUP BY message_id HAVING COUNT(DISTINCT session_id) > 1)",
    ),
    tokenRowsNotOwned: n("SELECT COUNT(*) n FROM token_usage x JOIN events e ON e.uuid = x.event_uuid WHERE e.session_id <> x.session_id"),
    toolRowsNotOwned: n("SELECT COUNT(*) n FROM tool_calls x JOIN events e ON e.uuid = x.event_uuid WHERE e.session_id <> x.session_id"),
  };
}
const NONE = { foreignKeys: 0, responsesInTwoSessions: 0, tokenRowsNotOwned: 0, toolRowsNotOwned: 0 };

describe("pipeline determinism over the committed corpus", () => {
  let fullSnap: string;
  let fullDb: any;
  beforeAll(() => {
    expect(allFiles.length).toBeGreaterThan(0); // corpus is present
    const { db, stmts, adapter } = newDb();
    ingest(db, stmts, adapter, allFiles);
    rebuildDerived(db); // full
    classify(db); // full
    detect(db); // full
    deriveFileChanges(db); // full
    fullSnap = snapshot(db);
    fullDb = db;
  });

  it("leaves no row pointing at a missing parent, and charges every line to the session that owns it", () => {
    expect(ownershipViolations(fullDb)).toEqual(NONE);
  });

  it("incremental (mains then subagents) reproduces the full-rebuild snapshot exactly", () => {
    const mains = allFiles.filter((f) => !basename(f).startsWith("agent-"));
    const subs = allFiles.filter((f) => basename(f).startsWith("agent-"));
    const { db, stmts, adapter } = newDb();
    // Run 1: mains only.
    ingest(db, stmts, adapter, mains);
    const e1 = rebuildDerived(db, sessionIdsOf(mains));
    classify(db, e1);
    detect(db, e1);
    deriveFileChanges(db, e1);
    // Run 2: subagents arrive later; expansion must pull their spawning parents back in.
    ingest(db, stmts, adapter, subs);
    const e2 = rebuildDerived(db, sessionIdsOf(subs));
    classify(db, e2);
    detect(db, e2);
    deriveFileChanges(db, e2);
    expect(snapshot(db)).toBe(fullSnap);
    expect(ownershipViolations(db)).toEqual(NONE);
  });

  it("is idempotent: re-ingesting unchanged files adds 0 events and changes nothing", () => {
    const { db, stmts, adapter } = newDb();
    ingest(db, stmts, adapter, allFiles);
    rebuildDerived(db);
    classify(db);
    detect(db);
    deriveFileChanges(db);
    const before = snapshot(db);
    const stats2 = ingest(db, stmts, adapter, allFiles); // second pass, identical content
    rebuildDerived(db);
    classify(db);
    detect(db);
    deriveFileChanges(db);
    expect(stats2.newEvents).toBe(0); // ON CONFLICT DO NOTHING — nothing new
    expect(snapshot(db)).toBe(before);
  });
});
