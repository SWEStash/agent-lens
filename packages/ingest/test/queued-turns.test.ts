/**
 * Regression tests for three ingest defects found in session 92d94ecd (a user prompt vanished from
 * the session view, and its `/login` produced two turns in the wrong order):
 *
 *   1. Queued prompts — a message typed while a turn is in flight — are logged by Claude Code as
 *      `type:"attachment"` with the text under `attachment.prompt`, NOT as a `user` event with a
 *      `message`. The adapter only read `message.content`, so the row landed with `text: null` and
 *      the web transcript dropped it (EventBlock bails when there's no body). The human's words were
 *      archived in raw_json but invisible everywhere else.
 *
 *   2. buildTurns broke timestamp ties on `uuid`, which is random. `/login` writes its command and
 *      its stdout with an IDENTICAL timestamp, so the pair could sort backwards — and any event
 *      tied with a prompt could be attributed to the wrong turn. `events.seq` (file line order) is
 *      the correct tiebreaker and is what the server already orders by.
 *
 *   3. `<local-command-stdout>` is a command *result* carried on a user line, not a prompt, but it
 *      satisfied the turn-start test and opened a second, bogus turn.
 *
 * Imports the BUILT output (dist) for the same reason as ingest.test.ts; the root `test` script
 * builds first.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { SourceFile } from "@agent-lens/core";
import { openDb } from "../dist/db.js";
import { prepareStatements, ingestFile, rebuildDerived, newStats } from "../dist/pipeline.js";
import { ClaudeCodeAdapter } from "../dist/adapters/claude-code.js";

const SOURCE = "test";
const AGENT = "claude-code";

function jsonl(...lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function file(sessionId: string, content: string): { file: SourceFile; content: string } {
  return {
    file: { path: `/fixtures/${sessionId}.jsonl`, sessionId, encodedDir: "-fixtures", isVersion: false, sourceId: SOURCE },
    content,
  };
}

// Reproduces the /login opening of session 92d94ecd: a meta caveat, the command, and its stdout, all
// three stamped with the SAME timestamp. The uuids are chosen so lexicographic order REVERSES file
// order ("a-cmd" < "b-stdout" would sort correctly, so the stdout is given the smaller uuid) — the
// exact condition that put the stdout in turn 0 and the command in turn 1.
const TIE = "2026-03-01T00:00:00.000Z";
const LOGIN = file(
  "sess-login",
  jsonl(
    { uuid: "aaa-caveat", type: "user", timestamp: TIE, isMeta: true, cwd: "/tmp/proj", message: { role: "user", content: "<local-command-caveat>Caveat: the messages below…</local-command-caveat>" } },
    { uuid: "zzz-command", type: "user", timestamp: TIE, message: { role: "user", content: "<command-name>/login</command-name>\n<command-message>login</command-message>" } },
    { uuid: "bbb-stdout", type: "user", timestamp: TIE, message: { role: "user", content: "<local-command-stdout>Login successful</local-command-stdout>" } },
    { uuid: "prompt-1", type: "user", timestamp: "2026-03-01T00:05:00.000Z", message: { role: "user", content: "compare our ATS handling against the reference" } },
    { uuid: "reply-1", type: "assistant", timestamp: "2026-03-01T00:06:00.000Z", message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "Comparing." }] } },
  ),
);

// An event tied on timestamp with a prompt must land in the prompt's turn, not the previous one.
// This is the `0c417626` attachment from 92d94ecd, which the uuid tiebreak pushed into turn 1.
const TIED = "2026-03-02T00:05:00.000Z";
const TIEBREAK = file(
  "sess-tiebreak",
  jsonl(
    { uuid: "t-first", type: "user", timestamp: "2026-03-02T00:00:00.000Z", cwd: "/tmp/proj", message: { role: "user", content: "first prompt" } },
    { uuid: "z-second", type: "user", timestamp: TIED, message: { role: "user", content: "second prompt" } },
    // Sorts before "z-second" by uuid, but comes AFTER it in the file, so it belongs to turn 1.
    { uuid: "a-attach", type: "attachment", timestamp: TIED, attachment: { type: "file", path: "/tmp/x" } },
  ),
);

// A turn in flight that absorbs three queued messages: a human prompt, a human prompt pasted with an
// image (content-block array), and a task-notification. Claude Code answers all of them inside the
// running turn — verified in the corpus — so none of them opens a new turn.
const QUEUED = file(
  "sess-queued",
  jsonl(
    { uuid: "q-prompt", type: "user", timestamp: "2026-03-03T00:00:00.000Z", cwd: "/tmp/proj", message: { role: "user", content: "start a long task" } },
    { uuid: "q-work", type: "assistant", timestamp: "2026-03-03T00:01:00.000Z", message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "Working." }] } },
    {
      uuid: "q-queued-str",
      type: "attachment",
      timestamp: "2026-03-03T00:02:00.000Z",
      attachment: { type: "queued_command", prompt: "and is the tagged PDF/A variant relevant here?", commandMode: "prompt", origin: { kind: "human" } },
    },
    {
      uuid: "q-queued-arr",
      type: "attachment",
      timestamp: "2026-03-03T00:03:00.000Z",
      attachment: {
        type: "queued_command",
        commandMode: "prompt",
        origin: { kind: "human" },
        prompt: [
          { type: "text", text: "this render looks wrong" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
        ],
      },
    },
    {
      uuid: "q-queued-notif",
      type: "attachment",
      timestamp: "2026-03-03T00:04:00.000Z",
      attachment: { type: "queued_command", prompt: "<task-notification>\n<task-id>abc123</task-id>\n</task-notification>", commandMode: "task-notification" },
    },
    { uuid: "q-answer", type: "assistant", timestamp: "2026-03-03T00:05:00.000Z", message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "Answering the queued question too." }] } },
  ),
);

let db: ReturnType<typeof openDb>;

beforeAll(() => {
  db = openDb(":memory:");
  const stmts = prepareStatements(db);
  const stats = newStats();
  const now = "2026-03-01T00:00:00.000Z";
  const adapter = new ClaudeCodeAdapter();
  stmts.insAgent.run(AGENT, "Claude Code CLI");
  stmts.insSource.run({ id: SOURCE, label: SOURCE, agent_id: AGENT, config_dir: null });
  for (const f of [LOGIN, TIEBREAK, QUEUED]) {
    ingestFile(db, stmts, adapter, f.file, f.content.split("\n"), { size: f.content.length, mtimeMs: 0, hash: f.file.sessionId }, now, stats);
  }
  rebuildDerived(db);
});

const turns = (sessionId: string) =>
  db.prepare("SELECT seq, user_event_uuid, prompt_preview FROM turns WHERE session_id = ? ORDER BY seq").all(sessionId) as any[];
const event = (uuid: string) => db.prepare("SELECT type, role, text, turn_id FROM events WHERE uuid = ?").get(uuid) as any;

describe("queued prompts (mid-flight messages)", () => {
  it("recovers the text of a queued human prompt from attachment.prompt", () => {
    expect(event("q-queued-str").text).toBe("and is the tagged PDF/A variant relevant here?");
  });

  it("marks a recovered queued prompt as a user message so it reads as one in the transcript", () => {
    // The line has no `message`, so role would otherwise be null and the transcript would label the
    // user's own words as a generic attachment.
    expect(event("q-queued-str").role).toBe("user");
    expect(event("q-queued-arr").role).toBe("user");
    // The notification isn't the user speaking; it keeps its null role.
    expect(event("q-queued-notif").role).toBeNull();
  });

  it("flattens a queued prompt sent as content blocks, keeping the text and dropping the image", () => {
    const e = event("q-queued-arr");
    expect(e.text).toBe("this render looks wrong");
    expect(e.text).not.toContain("iVBORw0KGgo");
  });

  it("leaves a queued task-notification without text — it is replayed later as a real user event", () => {
    expect(event("q-queued-notif").text).toBeNull();
  });

  it("absorbs a queued prompt into the turn already in flight instead of opening a new one", () => {
    // One prompt started this session; the queued messages arrived mid-turn and were answered in it.
    expect(turns("sess-queued").map((t) => t.seq)).toEqual([0]);
    expect(event("q-queued-str").turn_id).toBe("sess-queued:0");
    expect(event("q-queued-arr").turn_id).toBe("sess-queued:0");
  });
});

describe("turn boundaries and ordering", () => {
  it("orders events tied on timestamp by file line, so /login's command precedes its stdout", () => {
    const t = turns("sess-login");
    // The command opens turn 0; the stdout that follows it is not a turn of its own.
    expect(t[0].user_event_uuid).toBe("zzz-command");
    expect(t[0].prompt_preview).toContain("/login");
  });

  it("does not start a turn on a <local-command-stdout> result carrier", () => {
    const t = turns("sess-login");
    expect(t.map((x) => x.user_event_uuid)).toEqual(["zzz-command", "prompt-1"]);
    expect(t.some((x) => String(x.prompt_preview).includes("local-command-stdout"))).toBe(false);
    expect(event("bbb-stdout").turn_id).toBe("sess-login:0");
  });

  it("attributes an event tied with a prompt to that prompt's turn, not the previous one", () => {
    expect(event("a-attach").turn_id).toBe("sess-tiebreak:1");
  });
});
