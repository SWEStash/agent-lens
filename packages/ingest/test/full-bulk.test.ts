/**
 * `ingest --full` loads the events with four of their indexes and the FTS triggers absent, then
 * builds them once (resetSchema's `bulk`, finishBulkLoad). Maintaining them row by row was most of
 * the ~20 GB a rebuild wrote. What a rebuild leaves behind must still match a store built
 * incrementally: the same indexes and triggers, and a full-text index that finds every message and
 * keeps up with later runs.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { runIngest } from "../dist/run.js";
import { openDb } from "../dist/db.js";

let root: string;
let projects: string;
let dbPath: string;
const env = { CLAUDE_DIR: process.env.CLAUDE_DIR, AGENT_LENS_LABEL: process.env.AGENT_LENS_LABEL };

function session(id: string, text: string): void {
  const line = {
    type: "user",
    uuid: `${id}-u1`,
    sessionId: id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/work/demo",
    message: { role: "user", content: text },
  };
  writeFileSync(join(projects, `${id}.jsonl`), JSON.stringify(line) + "\n");
}

const ingest = (...extra: string[]) => runIngest(["--db", dbPath, "--archive", join(root, "archive"), ...extra]);

function read<T>(fn: (db: DatabaseSync) => T, file = dbPath): T {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
const schemaObjects = (db: DatabaseSync) =>
  db.prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') ORDER BY name").all();
const matching = (term: string) =>
  read((db) =>
    (db.prepare("SELECT e.session_id FROM events_fts f JOIN events e ON e.rowid = f.rowid WHERE events_fts MATCH ? ORDER BY 1").all(term) as Array<{ session_id: string }>).map(
      (r) => r.session_id,
    ),
  );

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "al-bulk."));
  projects = join(root, "archive", "test", "projects", "-work-demo");
  mkdirSync(projects, { recursive: true });
  dbPath = join(root, "test.db");
  process.env.CLAUDE_DIR = join(root, "claude");
  process.env.AGENT_LENS_LABEL = "test";
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

describe("ingest --full bulk load", () => {
  it("leaves the same indexes and triggers as a fresh schema", () => {
    session("s1", "alpha");
    ingest("--full");
    const fresh = join(root, "fresh.db");
    openDb(fresh).close();
    expect(read(schemaObjects)).toEqual(read(schemaObjects, fresh));
  });

  it("indexes every message for search, consistently", () => {
    session("s1", "alpha bravo");
    session("s2", "bravo charlie");
    ingest("--full");
    expect(matching("bravo")).toEqual(["s1", "s2"]);
    expect(matching("charlie")).toEqual(["s2"]);
    const db = new DatabaseSync(dbPath);
    try {
      expect(() => db.exec("INSERT INTO events_fts(events_fts) VALUES('integrity-check')")).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("keeps search current on the incremental runs after it", () => {
    session("s1", "alpha");
    ingest("--full");
    session("s2", "delta");
    ingest();
    expect(matching("delta")).toEqual(["s2"]);
  });
});
