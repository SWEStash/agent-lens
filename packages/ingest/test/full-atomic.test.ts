/**
 * `ingest --full` is one transaction. It used to drop the tables and refill them across one commit
 * per file, so for the minutes a rebuild took the server read missing or half-filled tables, and a
 * run that died partway left the store that way. Now a failed rebuild rolls back to the previous
 * state whole. The failure is injected with an unreadable transcript, which root can still read.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { runIngest } from "../dist/run.js";

let root: string;
let projects: string;
let dbPath: string;
const env = { CLAUDE_DIR: process.env.CLAUDE_DIR, AGENT_LENS_LABEL: process.env.AGENT_LENS_LABEL };

function session(id: string): void {
  const line = {
    type: "user",
    uuid: `${id}-u1`,
    sessionId: id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/work/demo",
    message: { role: "user", content: "hello" },
  };
  writeFileSync(join(projects, `${id}.jsonl`), JSON.stringify(line) + "\n");
}

const ingest = (...extra: string[]) => runIngest(["--db", dbPath, "--archive", join(root, "archive"), ...extra]);
const sessions = () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("SELECT id FROM sessions ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
  } finally {
    db.close();
  }
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "al-full."));
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

describe("ingest --full", () => {
  it("rebuilds the store from the archive", () => {
    session("s1");
    session("s2");
    ingest();
    ingest("--full");
    expect(sessions()).toEqual(["s1", "s2"]);
  });

  it.skipIf(process.getuid?.() === 0)("leaves the previous store intact when it fails partway", () => {
    session("s1");
    session("s2");
    ingest();
    // The archive now differs from the store, so a partial rebuild cannot pass for the old one
    // whichever order the files are read in.
    rmSync(join(projects, "s2.jsonl"));
    session("s3");
    chmodSync(join(projects, "s3.jsonl"), 0o000);

    expect(() => ingest("--full")).toThrow(/EACCES/);
    expect(sessions()).toEqual(["s1", "s2"]);
  });
});
