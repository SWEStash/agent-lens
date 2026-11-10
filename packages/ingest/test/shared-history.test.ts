/**
 * History shared between sessions (ADR-038). Claude Code 2.1.318+ writes a continued session as a new
 * transcript that repeats the old one's lines under the same uuids, and appends a `continued-in`
 * pointer to the old file. Forks copy history the same way without a pointer.
 *
 * Regression for the 2026-11-04 outage: a copy whose every line was already owned by another session
 * kept its token_usage rows, was pruned as a zero-event phantom, and the orphaned rows failed the
 * deferred foreign key at COMMIT on every ingest.
 */
import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SourceFile } from "@agent-lens/core";
import { openDb } from "../dist/db.js";
import { prepareStatements, ingestFile, rebuildDerived, newStats } from "../dist/pipeline.js";
import { ClaudeCodeAdapter } from "../dist/adapters/claude-code.js";
import { jsonl } from "./helpers/seed.js";
import { withArchive } from "./helpers/archive.js";

const SOURCE = "test";
const T = (s: number) => `2026-11-04T22:03:${String(s).padStart(2, "0")}.000Z`;
const usage = (i: number) => ({ input_tokens: i, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

/** A line as the original session wrote it; `sid` is the transcript's own sessionId field. */
const user = (uuid: string, s: number, sid: string, text: string) => ({ uuid, type: "user", sessionId: sid, timestamp: T(s), cwd: "/p", message: { role: "user", content: text } });
const asst = (uuid: string, s: number, sid: string, msg: string, tokens: number) => ({
  uuid,
  type: "assistant",
  sessionId: sid,
  timestamp: T(s),
  message: { id: msg, role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "ok" }], usage: usage(tokens) },
});

// Claude Code writes one API response as one line per content block, all carrying the same message id
// and usage. Ingest keeps one token_usage row per (session, message), keyed by the FIRST line's uuid,
// so it is the copies of the later lines (a3 below) that used to leak.
// Original: one prompt and a two-block reply, then the pointer Claude Code appends when the session continues.
const ORIGINAL = jsonl(
  user("a1", 1, "orig", "first prompt"),
  asst("a2", 2, "orig", "msg_A", 100),
  asst("a3", 2, "orig", "msg_A", 100),
  { type: "continued-in", sessionId: "orig", timestamp: T(3), continuedInSessionId: "cont" },
);
// Continuation: the original's lines, same uuids, sessionId rewritten; then its own work.
const CONTINUATION = jsonl(
  user("a1", 1, "cont", "first prompt"),
  asst("a2", 2, "cont", "msg_A", 100),
  asst("a3", 2, "cont", "msg_A", 100),
  user("b1", 10, "cont", "second prompt"),
  asst("b2", 11, "cont", "msg_B", 7),
);
// The incident's shape: a copy holding nothing of its own.
const PURE_COPY = jsonl(user("a1", 1, "copy", "first prompt"), asst("a2", 2, "copy", "msg_A", 100), asst("a3", 2, "copy", "msg_A", 100));

function sf(sessionId: string): SourceFile {
  return { path: `/r/projects/-p/${sessionId}.jsonl`, sessionId, encodedDir: "-p", isVersion: false, sourceId: SOURCE };
}

function ingestAll(files: Array<[string, string]>) {
  const db = openDb(":memory:");
  const stmts = prepareStatements(db);
  stmts.insAgent.run("claude-code", "Claude Code CLI");
  stmts.insSource.run({ id: SOURCE, label: SOURCE, agent_id: "claude-code", config_dir: null });
  const adapter = new ClaudeCodeAdapter();
  // One outer transaction with deferred FKs, as the real run does: a violation surfaces at COMMIT.
  db.exec("BEGIN");
  for (const [id, content] of files) {
    ingestFile(db, stmts, adapter, sf(id), content.split("\n"), { size: content.length, mtimeMs: 0, hash: id }, "2026-11-08T00:00:00.000Z", newStats());
  }
  rebuildDerived(db, new Set(files.map(([id]) => id)));
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  db.exec("COMMIT");
  return { db, violations };
}

const tokensBySession = (db: any) =>
  Object.fromEntries((db.prepare("SELECT session_id s, SUM(input_tokens) n FROM token_usage GROUP BY session_id").all() as any[]).map((r) => [r.s, r.n]));

describe("history shared between sessions (ADR-038)", () => {
  it("counts a continuation's copied lines once, in the session that owns them", () => {
    const { db, violations } = ingestAll([
      ["orig", ORIGINAL],
      ["cont", CONTINUATION],
    ]);
    expect(violations).toEqual([]);
    expect(tokensBySession(db)).toEqual({ orig: 100, cont: 7 });
  });

  it("leaves no orphaned rows when a copy with nothing of its own is ingested after its original", () => {
    const { db, violations } = ingestAll([
      ["orig", ORIGINAL],
      ["copy", PURE_COPY],
    ]);
    expect(violations).toEqual([]);
    expect(tokensBySession(db)).toEqual({ orig: 100 });
  });

  it("never writes a token_usage or tool_calls row whose session does not own the event", () => {
    const { db } = ingestAll([
      ["cont", CONTINUATION],
      ["orig", ORIGINAL],
    ]);
    const mismatched = (t: string) =>
      (db.prepare(`SELECT COUNT(*) n FROM ${t} x JOIN events e ON e.uuid = x.event_uuid WHERE e.session_id <> x.session_id`).get() as any).n;
    expect(mismatched("token_usage")).toBe(0);
    expect(mismatched("tool_calls")).toBe(0);
  });
});

describe("a copy links to the session it continues (ADR-038)", () => {
  const link = (db: any, id: string) => (db.prepare("SELECT continued_from_session_id c FROM sessions WHERE id = ?").get(id) as any)?.c;

  it("links a continuation to its original through the continued-in pointer", () => {
    const { db } = ingestAll([
      ["orig", ORIGINAL],
      ["cont", CONTINUATION],
    ]);
    expect(link(db, "cont")).toBe("orig");
    expect(link(db, "orig")).toBeNull();
  });

  it("links a fork that carries no pointer through the history it shares", () => {
    const original = ORIGINAL.split("\n").filter((l) => !l.includes("continued-in")).join("\n");
    const { db } = ingestAll([
      ["orig", original],
      ["fork", CONTINUATION],
    ]);
    expect(link(db, "fork")).toBe("orig");
    expect(link(db, "orig")).toBeNull();
  });

  it("keeps the link when the continuation is re-ingested in a later run with nothing new", () => {
    const { db } = ingestAll([
      ["orig", ORIGINAL],
      ["cont", CONTINUATION],
    ]);
    const stmts = prepareStatements(db);
    ingestFile(db, stmts, new ClaudeCodeAdapter(), sf("cont"), CONTINUATION.split("\n"), { size: 1, mtimeMs: 1, hash: "again" }, "2026-11-09T00:00:00.000Z", newStats());
    rebuildDerived(db, new Set(["cont"]));
    expect(link(db, "cont")).toBe("orig");
  });

  it("leaves sessions that share nothing unlinked", () => {
    const { db } = ingestAll([["solo", jsonl(user("x1", 1, "solo", "hi"), asst("x2", 2, "solo", "msg_X", 5))]]);
    expect(link(db, "solo")).toBeNull();
  });
});

describe("which session owns shared history, through a real ingest run (ADR-038)", () => {
  const a = withArchive("al-shared.");
  const read = <T>(sql: string): T[] => {
    const db = new DatabaseSync(a.dbPath, { readOnly: true });
    try {
      return db.prepare(sql).all() as T[];
    } finally {
      db.close();
    }
  };
  const eventsBySession = () =>
    Object.fromEntries(read<{ s: string; n: number }>("SELECT session_id s, COUNT(*) n FROM events GROUP BY session_id").map((r) => [r.s, r.n]));

  // Discovery order is readdir order, which no test controls; cover both name orders and both write
  // orders so the file order can never be what puts the original first.
  const cases = [
    { orig: "a-orig", copy: "b-copy", origFirst: true },
    { orig: "a-orig", copy: "b-copy", origFirst: false },
    { orig: "b-orig", copy: "a-copy", origFirst: true },
    { orig: "b-orig", copy: "a-copy", origFirst: false },
  ];

  it.each(cases)("the original ($orig) keeps its lines when its continuation ($copy) arrives in the same run, written first: $origFirst", ({ orig, copy, origFirst }) => {
    const files: Array<[string, string]> = [
      [orig, ORIGINAL],
      [copy, CONTINUATION],
    ];
    for (const [id, content] of origFirst ? files : files.reverse()) writeFileSync(join(a.projects, `${id}.jsonl`), content);
    a.ingest();
    expect(eventsBySession()).toEqual({ [orig]: 3, [copy]: 2 });
  });

  it.each(cases)("the original ($orig) survives a copy ($copy) that holds nothing of its own, written first: $origFirst", ({ orig, copy, origFirst }) => {
    const files: Array<[string, string]> = [
      [orig, ORIGINAL],
      [copy, PURE_COPY],
    ];
    for (const [id, content] of origFirst ? files : files.reverse()) writeFileSync(join(a.projects, `${id}.jsonl`), content);
    a.ingest();
    expect(eventsBySession()).toEqual({ [orig]: 3 });
  });
});

describe("a continuation arriving across runs matches a full rebuild (ADR-010, ADR-038)", () => {
  const a = withArchive("al-shared-runs.");
  const state = () => {
    const db = new DatabaseSync(a.dbPath, { readOnly: true });
    try {
      const all = (sql: string) => JSON.stringify(db.prepare(sql).all());
      return [
        all("SELECT id, continued_from_session_id, event_count FROM sessions ORDER BY id"),
        all("SELECT uuid, session_id FROM events ORDER BY uuid"),
        all("SELECT event_uuid, session_id, input_tokens FROM token_usage ORDER BY event_uuid"),
      ].join("\n");
    } finally {
      db.close();
    }
  };
  const write = (id: string, content: string) => writeFileSync(join(a.projects, `${id}.jsonl`), content);
  const beforeHandoff = ORIGINAL.split("\n").filter((l) => !l.includes("continued-in")).join("\n");

  it("gives the same store whether the original and its continuation arrive in one run or two", () => {
    // Run 1: the original, still open. Run 2: Claude Code has appended the pointer and the
    // continuation exists. The continuation is named to sort first, so path order cannot help.
    write("zz-orig", beforeHandoff);
    a.ingest();
    write("zz-orig", ORIGINAL.replace('"continuedInSessionId":"cont"', '"continuedInSessionId":"aa-cont"'));
    write("aa-cont", CONTINUATION);
    a.ingest();
    const incremental = state();

    a.ingest("--full");
    expect(state()).toBe(incremental);
    expect(incremental).toContain('{"id":"aa-cont","continued_from_session_id":"zz-orig","event_count":2}');
  });

  it("links a continuation to a pointer that arrives in a later run, even when they share no lines", () => {
    // Run 1: a continuation holding only its own work. Run 2: the original, with the pointer. Only
    // the original's file changed, so the link depends on the dirty scope reaching the continuation.
    const ownWorkOnly = CONTINUATION.split("\n").filter((l) => !/"uuid":"a[123]"/.test(l)).join("\n");
    write("aa-cont", ownWorkOnly);
    a.ingest();
    write("zz-orig", ORIGINAL.replace('"continuedInSessionId":"cont"', '"continuedInSessionId":"aa-cont"'));
    a.ingest();
    const incremental = state();
    expect(incremental).toContain('{"id":"aa-cont","continued_from_session_id":"zz-orig","event_count":2}');

    a.ingest("--full");
    expect(state()).toBe(incremental);
  });
});

describe("a fork subagent's copy of its parent's reply (ADR-038)", () => {
  it("charges a response once, even when the copy carries a new line uuid", () => {
    // A fork subagent opens with a fork-context-ref line, then re-emits the parent's spawning reply
    // under a NEW uuid but the same message id and usage. uuid dedup cannot see it; message id can.
    const parent = jsonl(user("p1", 1, "par", "fork two investigations"), asst("p2", 2, "par", "msg_FORK", 218));
    const fork = jsonl(
      { type: "fork-context-ref", agentId: "f1" },
      { ...asst("f-copy", 9, "par", "msg_FORK", 218), isSidechain: true, agentId: "f1" },
      { ...asst("f-own", 10, "par", "msg_OWN", 5), isSidechain: true, agentId: "f1" },
    );
    const { db, violations } = ingestAll([
      ["par", parent],
      ["agent-f1", fork],
    ]);
    expect(violations).toEqual([]);
    expect(tokensBySession(db)).toEqual({ par: 218, "agent-f1": 5 });
  });
});
