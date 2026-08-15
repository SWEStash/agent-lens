/**
 * `events.text` and `events.thinking` are stored as separate columns (schema v15).
 *
 * They used to be merged into one `text` column, which forced the server to re-derive the split from
 * `raw_json` on every transcript read — a second implementation of the adapter's own parsing, and the
 * reason a record-shape fix had to land in two packages at once. Storing both lets the read path be a
 * plain column select.
 *
 * The FTS assertions here are a *preservation* guard, not a new behavior: thinking text was searchable
 * before only because it was merged into `text`, so `events_fts` now indexes both columns. These pass
 * before and after the split — that is exactly what makes them the guard against silently losing
 * search coverage.
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

// "zephyrine" appears ONLY inside a thinking block, and "marmalade" only in visible text — so each
// term proves its own column is indexed, with no overlap to hide a broken one.
const T = (n: number) => `2026-04-01T00:0${n}:00.000Z`;
const SESSION = file(
  "sess-thinking",
  jsonl(
    { uuid: "th-prompt", type: "user", timestamp: T(1), cwd: "/tmp/proj", message: { role: "user", content: "explain the tradeoff" } },
    {
      uuid: "th-both",
      type: "assistant",
      timestamp: T(2),
      message: {
        role: "assistant",
        model: "claude-opus-5",
        // Interleaved on purpose: the walker must key off block type, not position.
        content: [
          { type: "thinking", thinking: "considering zephyrine first" },
          { type: "text", text: "The marmalade approach wins." },
          { type: "thinking", thinking: "second thought" },
        ],
      },
    },
    { uuid: "th-textonly", type: "assistant", timestamp: T(3), message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "No thinking here." }] } },
  ),
);

let db: ReturnType<typeof openDb>;

beforeAll(() => {
  db = openDb(":memory:");
  const stmts = prepareStatements(db);
  const stats = newStats();
  const adapter = new ClaudeCodeAdapter();
  stmts.insAgent.run(AGENT, "Claude Code CLI");
  stmts.insSource.run({ id: SOURCE, label: SOURCE, agent_id: AGENT, config_dir: null });
  ingestFile(db, stmts, adapter, SESSION.file, SESSION.content.split("\n"), { size: SESSION.content.length, mtimeMs: 0, hash: "h" }, T(0), stats);
  rebuildDerived(db);
});

const event = (uuid: string) => db.prepare("SELECT text, thinking FROM events WHERE uuid = ?").get(uuid) as any;
/** The session-search predicate the API uses: an unqualified MATCH, which spans every FTS column. */
const ftsHits = (term: string) =>
  db
    .prepare("SELECT DISTINCT e.session_id s FROM events e JOIN events_fts f ON f.rowid = e.rowid WHERE events_fts MATCH ?")
    .all(`"${term}"`)
    .map((r: any) => r.s);

describe("text and thinking are stored as separate columns", () => {
  it("splits an interleaved record into its two streams", () => {
    const e = event("th-both");
    expect(e.text).toBe("The marmalade approach wins.");
    expect(e.thinking).toBe("considering zephyrine first\nsecond thought");
  });

  it("keeps thinking out of the text column", () => {
    expect(event("th-both").text).not.toContain("zephyrine");
  });

  it("leaves thinking null on a record that has none", () => {
    const e = event("th-textonly");
    expect(e.text).toBe("No thinking here.");
    expect(e.thinking).toBeNull();
  });
});

describe("full-text search still spans both columns", () => {
  it("finds a session by a term that appears only in thinking", () => {
    expect(ftsHits("zephyrine")).toContain("sess-thinking");
  });

  it("still finds a session by a term in visible text", () => {
    expect(ftsHits("marmalade")).toContain("sess-thinking");
  });
});
