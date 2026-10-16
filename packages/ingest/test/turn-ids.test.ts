/**
 * An event's turn_id used to be written twice: NULL at insert, then set by rebuildTurns, after a
 * scoped null-out on incremental runs. An events row is a few KB, and NULL to a value changes its
 * size, so each write rewrote the whole row: 511k rows on the real store's `--full`. Now `--full`
 * inserts each event with the turn its file's line order implies (99.4% of events on the real
 * store), and rebuildTurns writes only the ones whose turn comes out different. It still decides:
 * turns follow timestamps, which is what these tests pin.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { runIngest } from "../dist/run.js";

let root: string;
let projects: string;
let dbPath: string;
const env = { CLAUDE_DIR: process.env.CLAUDE_DIR, AGENT_LENS_LABEL: process.env.AGENT_LENS_LABEL };

const line = (session: string, n: number, type: "user" | "assistant", text: string, ts: string) =>
  JSON.stringify({
    type,
    uuid: `${session}-${n}`,
    sessionId: session,
    timestamp: ts,
    cwd: "/work/demo",
    message: type === "user" ? { role: "user", content: text } : { role: "assistant", content: [{ type: "text", text }] },
  }) + "\n";

const ingest = (...extra: string[]) => runIngest(["--db", dbPath, "--archive", join(root, "archive"), ...extra]);
const turnIds = () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Object.fromEntries((db.prepare("SELECT uuid, turn_id FROM events ORDER BY uuid").all() as Array<{ uuid: string; turn_id: string | null }>).map((r) => [r.uuid, r.turn_id]));
  } finally {
    db.close();
  }
};

/** Count runs of the per-event turn_id UPDATE across every connection runIngest opens. */
function countTurnUpdates(fn: () => void): number {
  const prepare = DatabaseSync.prototype.prepare;
  let n = 0;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    const st = prepare.call(this, sql);
    if (/^UPDATE events SET turn_id = \? WHERE uuid = \?/.test(sql.trim())) {
      const run = st.run.bind(st);
      st.run = ((...a: Parameters<typeof run>) => (n++, run(...a))) as typeof st.run;
    }
    return st;
  } as typeof prepare;
  try {
    fn();
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
  return n;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "al-turns."));
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

describe("event turn_id", () => {
  it("--full writes no event twice when line order matches the timestamps", () => {
    writeFileSync(
      join(projects, "s1.jsonl"),
      line("s1", 1, "user", "first", "2026-01-01T00:00:00.000Z") +
        line("s1", 2, "assistant", "ok", "2026-01-01T00:00:01.000Z") +
        line("s1", 3, "user", "second", "2026-01-01T00:00:02.000Z"),
    );
    expect(countTurnUpdates(() => ingest("--full"))).toBe(0);
    expect(turnIds()).toEqual({ "s1-1": "s1:0", "s1-2": "s1:0", "s1-3": "s1:1" });
  });

  it("--full follows the timestamps where line order disagrees", () => {
    // The second line is the earlier prompt, so it opens turn 0 and the reply lands in its turn.
    writeFileSync(
      join(projects, "s1.jsonl"),
      line("s1", 1, "user", "later", "2026-01-01T00:00:05.000Z") +
        line("s1", 2, "user", "earlier", "2026-01-01T00:00:00.000Z") +
        line("s1", 3, "assistant", "reply", "2026-01-01T00:00:01.000Z"),
    );
    ingest("--full");
    expect(turnIds()).toEqual({ "s1-1": "s1:1", "s1-2": "s1:0", "s1-3": "s1:0" });
  });

  it("an incremental run assigns new events and keeps the rest", () => {
    const file = join(projects, "s1.jsonl");
    writeFileSync(file, line("s1", 1, "user", "first", "2026-01-01T00:00:00.000Z") + line("s1", 2, "assistant", "ok", "2026-01-01T00:00:01.000Z"));
    ingest();
    appendFileSync(file, line("s1", 3, "user", "second", "2026-01-01T00:00:02.000Z") + line("s1", 4, "assistant", "done", "2026-01-01T00:00:03.000Z"));
    // Only the two new events need a turn_id; the first two already have theirs.
    expect(countTurnUpdates(() => ingest())).toBe(2);
    expect(turnIds()).toEqual({ "s1-1": "s1:0", "s1-2": "s1:0", "s1-3": "s1:1", "s1-4": "s1:1" });
  });
});
