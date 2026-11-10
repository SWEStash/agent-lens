/**
 * When ingest would commit a row whose parent is missing, the error has to say which rows. SQLite's
 * own report is `FOREIGN KEY constraint failed` at COMMIT, with no table, key or session: the
 * 2026-11-04 outage took a copy of the store and a patched build to trace back to its three sessions.
 */
import { describe, it, expect } from "vitest";
import { openDb } from "../dist/db.js";
import { foreignKeyViolations, assertForeignKeys } from "../dist/fkcheck.js";

function storeWithOrphans() {
  const db = openDb(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("INSERT INTO agents (id, name) VALUES ('claude-code', 'Claude Code CLI')");
  db.exec("INSERT INTO sessions (id, agent_id) VALUES ('owner', 'claude-code')");
  for (const [uuid, sid] of [["e1", "owner"], ["e2", "owner"], ["e3", "owner"]]) {
    db.prepare("INSERT INTO events (uuid, session_id, type, raw_json, source_file) VALUES (?, ?, 'assistant', x'00', ?)").run(uuid, sid, `/a/${sid}.jsonl`);
  }
  // Two usage rows charged to a session that does not exist, as the outage left them.
  db.exec("INSERT INTO token_usage (event_uuid, session_id, message_id) VALUES ('e2', 'gone-1', 'm2'), ('e3', 'gone-1', 'm3')");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

describe("foreign-key diagnostics", () => {
  it("is empty for a consistent store", () => {
    expect(foreignKeyViolations(openDb(":memory:"))).toEqual([]);
  });

  it("groups violations by edge, with the missing keys and the files that produced them", () => {
    expect(foreignKeyViolations(storeWithOrphans())).toEqual([
      { table: "token_usage", column: "session_id", parent: "sessions", rows: 2, missing: ["gone-1"], files: ["/a/owner.jsonl"] },
    ]);
  });

  it("throws an error that names the edge, the missing session and the file", () => {
    expect(() => assertForeignKeys(storeWithOrphans())).toThrow(/token_usage\.session_id -> sessions: 2 rows.*gone-1.*\/a\/owner\.jsonl/s);
  });
});
