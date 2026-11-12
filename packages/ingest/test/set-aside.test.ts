/**
 * Transcripts Claude Code sets aside instead of overwriting (#75):
 * `<session>.orphaned-<ts>-<suffix>.jsonl` and `<session>.jsonl.superseded-<ts>`. Both hold earlier
 * history of `<session>`. They must be ingested under that session id, like a `.versions/` snapshot,
 * and must not become sessions of their own.
 */
import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withArchive } from "./helpers/archive.js";
import { transcriptSessionId } from "../dist/adapters/claude-code.js";

const a = withArchive("al-setaside.");
const SID = "0b7d2c1e-0000-4000-8000-000000000001";

const line = (uuid: string, s: number, text: string) =>
  JSON.stringify({ type: "user", uuid, sessionId: SID, timestamp: `2026-11-01T12:00:0${s}.000Z`, cwd: "/work/demo", message: { role: "user", content: text } }) + "\n";

function rows<T>(sql: string): T[] {
  const db = new DatabaseSync(a.dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

describe("set-aside transcripts", () => {
  it("parses the session id from every transcript file name", () => {
    expect(transcriptSessionId(`${SID}.jsonl`)).toEqual({ sessionId: SID, setAside: false });
    expect(transcriptSessionId(`${SID}.orphaned-20261101T120000-ab12.jsonl`)).toEqual({ sessionId: SID, setAside: true });
    expect(transcriptSessionId(`${SID}.jsonl.superseded-20261101T120000`)).toEqual({ sessionId: SID, setAside: true });
    expect(transcriptSessionId("agent-a1.jsonl")).toEqual({ sessionId: "agent-a1", setAside: false });
    expect(transcriptSessionId("notes.txt")).toBeNull();
  });

  it("ingests both forms under the real session id, with no extra session", async () => {
    writeFileSync(join(a.projects, `${SID}.jsonl`), line("e3", 3, "live"));
    writeFileSync(join(a.projects, `${SID}.orphaned-20261101T120000-ab12.jsonl`), line("e1", 1, "orphaned") + line("e3", 3, "live"));
    writeFileSync(join(a.projects, `${SID}.jsonl.superseded-20261101T120000`), line("e2", 2, "superseded"));
    await a.ingest();
    expect(rows<{ id: string }>("SELECT id FROM sessions").map((r) => r.id)).toEqual([SID]);
    expect(rows<{ uuid: string; session_id: string }>("SELECT uuid, session_id FROM events ORDER BY uuid")).toEqual([
      { uuid: "e1", session_id: SID },
      { uuid: "e2", session_id: SID },
      { uuid: "e3", session_id: SID },
    ]);
  });
});
