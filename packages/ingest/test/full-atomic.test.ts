/**
 * `ingest --full` is one transaction. It used to drop the tables and refill them across one commit
 * per file, so for the minutes a rebuild took the server read missing or half-filled tables, and a
 * run that died partway left the store that way. Now a failed rebuild rolls back to the previous
 * state whole. The failure is injected with an unreadable transcript, which root can still read.
 */
import { describe, it, expect } from "vitest";
import { rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withArchive } from "./helpers/archive.js";

const a = withArchive("al-full.");


function session(id: string): void {
  const line = {
    type: "user",
    uuid: `${id}-u1`,
    sessionId: id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/work/demo",
    message: { role: "user", content: "hello" },
  };
  writeFileSync(join(a.projects, `${id}.jsonl`), JSON.stringify(line) + "\n");
}

const sessions = () => {
  const db = new DatabaseSync(a.dbPath, { readOnly: true });
  try {
    return (db.prepare("SELECT id FROM sessions ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
  } finally {
    db.close();
  }
};


describe("ingest --full", () => {
  it("rebuilds the store from the archive", () => {
    session("s1");
    session("s2");
    a.ingest();
    a.ingest("--full");
    expect(sessions()).toEqual(["s1", "s2"]);
  });

  it.skipIf(process.getuid?.() === 0)("leaves the previous store intact when it fails partway", () => {
    session("s1");
    session("s2");
    a.ingest();
    // The archive now differs from the store, so a partial rebuild cannot pass for the old one
    // whichever order the files are read in.
    rmSync(join(a.projects, "s2.jsonl"));
    session("s3");
    chmodSync(join(a.projects, "s3.jsonl"), 0o000);

    expect(() => a.ingest("--full")).toThrow(/EACCES/);
    expect(sessions()).toEqual(["s1", "s2"]);
  });
});
