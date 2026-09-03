/**
 * File-modification provenance (ADR-022) — deriveFileChanges in filechanges.ts. We drive the real
 * pass over a directly-seeded DB and read the materialized `file_changes` rows. Foreign keys are
 * left OFF (same stance as detect.test.ts): we test deterministic derivation, not referential
 * integrity. Imports the BUILT dist.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "@agent-lens/core";
import { deriveFileChanges, normalizeFilePath, FILECHANGES_VERSION } from "../dist/filechanges.js";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec("PRAGMA foreign_keys = OFF");
  return db;
}

/** Seed a session (optionally with a project path, for relative-path resolution + project_id). */
function addSession(db: DatabaseSync, id: string, projectPath?: string) {
  if (projectPath) {
    const pid = `p-${id}`;
    db.prepare(`INSERT INTO projects (id, agent_id, path) VALUES (?, 'claude-code', ?)`).run(pid, projectPath);
    db.prepare(`INSERT INTO sessions (id, agent_id, project_id) VALUES (?, 'claude-code', ?)`).run(id, pid);
  } else {
    db.prepare(`INSERT INTO sessions (id, agent_id) VALUES (?, 'claude-code')`).run(id);
  }
}

let seq = 0;
/** Seed a tool call (+ its event, so the derived row picks up a timestamp); returns its id. */
function addTool(
  db: DatabaseSync,
  session: string,
  tool: string,
  opts: { input?: any; status?: string; turn?: string; ts?: string } = {},
): string {
  const id = `tc-${seq++}`;
  db.prepare(
    `INSERT INTO events (uuid, session_id, type, timestamp, raw_json) VALUES (?, ?, 'assistant', ?, x'00')`,
  ).run(`ev-${id}`, session, opts.ts ?? "2026-07-01T00:00:00Z");
  db.prepare(
    `INSERT INTO tool_calls (id, session_id, turn_id, event_uuid, tool_name, input_json, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, session, opts.turn ?? null, `ev-${id}`, tool, opts.input != null ? JSON.stringify(opts.input) : null, opts.status ?? "success");
  return id;
}

const rowsFor = (db: DatabaseSync, session: string) =>
  db.prepare("SELECT * FROM file_changes WHERE session_id = ? ORDER BY tool_call_id").all(session) as any[];

describe("normalizeFilePath", () => {
  it("normalizes absolute paths and resolves relative ones against the project root", () => {
    expect(normalizeFilePath("/a/b/../c.ts", null)).toBe("/a/c.ts");
    expect(normalizeFilePath("src/x.ts", "/proj")).toBe("/proj/src/x.ts");
    expect(normalizeFilePath("../out.ts", "/proj/sub")).toBe("/proj/out.ts");
    expect(normalizeFilePath("src/x.ts", null)).toBeNull(); // relative + unknown project → skip
    expect(normalizeFilePath("", "/proj")).toBeNull();
    expect(normalizeFilePath(42, "/proj")).toBeNull();
  });
});

describe("deriveFileChanges", () => {
  it("derives rows from Edit/Write/NotebookEdit with line counts, project id, and timestamp", () => {
    const db = freshDb();
    addSession(db, "s", "/proj");
    const e = addTool(db, "s", "Edit", {
      input: { file_path: "/proj/src/a.ts", old_string: "one\ntwo", new_string: "one\ntwo\nthree" },
      ts: "2026-07-02T10:00:00Z",
    });
    const w = addTool(db, "s", "Write", { input: { file_path: "/proj/b.md", content: "x\ny\nz" } });
    const n = addTool(db, "s", "NotebookEdit", { input: { notebook_path: "/proj/nb.ipynb", new_source: "cell" } });
    deriveFileChanges(db);

    const rows = rowsFor(db, "s");
    expect(rows).toHaveLength(3);
    const edit = rows.find((r) => r.tool_call_id === e);
    expect(edit).toMatchObject({
      file_path: "/proj/src/a.ts",
      tool_name: "Edit",
      lines_added: 3,
      lines_removed: 2,
      project_id: "p-s",
      event_uuid: `ev-${e}`,
      timestamp: "2026-07-02T10:00:00Z",
      derive_version: FILECHANGES_VERSION,
    });
    const write = rows.find((r) => r.tool_call_id === w);
    expect(write).toMatchObject({ tool_name: "Write", lines_added: 3, lines_removed: null });
    const nb = rows.find((r) => r.tool_call_id === n);
    expect(nb).toMatchObject({ file_path: "/proj/nb.ipynb", lines_added: null, lines_removed: null });
  });

  it("excludes failed calls, non-file tools, and unparseable/pathless inputs", () => {
    const db = freshDb();
    addSession(db, "s", "/proj");
    addTool(db, "s", "Edit", { input: { file_path: "/proj/x.ts", old_string: "a", new_string: "b" }, status: "error" });
    addTool(db, "s", "Bash", { input: { command: "echo hi > /proj/y.ts" }, status: "error" });
    addTool(db, "s", "Bash", { input: { command: "grep -rn foo src | head -20" } }); // reads only
    addTool(db, "s", "Edit", { input: { old_string: "a", new_string: "b" } }); // no path
    const bad = addTool(db, "s", "Write", {});
    db.prepare("UPDATE tool_calls SET input_json = '{not json' WHERE id = ?").run(bad);
    deriveFileChanges(db);
    expect(rowsFor(db, "s")).toHaveLength(0);
  });

  it("normalizes traversal and resolves relative paths so file identities group correctly", () => {
    const db = freshDb();
    addSession(db, "s", "/proj");
    addTool(db, "s", "Edit", { input: { file_path: "/proj/src/../src/a.ts", old_string: "a", new_string: "b" } });
    addTool(db, "s", "Write", { input: { file_path: "src/a.ts", content: "c" } });
    deriveFileChanges(db);
    const rows = rowsFor(db, "s");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.file_path))).toEqual(new Set(["/proj/src/a.ts"]));
  });

  it("is deterministic and re-runnable: full and incremental re-runs reproduce identical rows", () => {
    const db = freshDb();
    addSession(db, "s1", "/proj");
    addSession(db, "s2", "/proj2");
    addTool(db, "s1", "Edit", { input: { file_path: "/proj/a.ts", old_string: "a", new_string: "b" } });
    addTool(db, "s2", "Write", { input: { file_path: "/proj2/b.ts", content: "x" } });
    deriveFileChanges(db);
    const before = db.prepare("SELECT * FROM file_changes ORDER BY id").all();

    deriveFileChanges(db); // full re-run
    expect(db.prepare("SELECT * FROM file_changes ORDER BY id").all()).toEqual(before);

    deriveFileChanges(db, new Set(["s1"])); // incremental: only s1 delete-then-inserted
    expect(db.prepare("SELECT * FROM file_changes ORDER BY id").all()).toEqual(before);
  });

  it("incremental scope leaves other sessions' rows untouched and drops stale rows of dirty ones", () => {
    const db = freshDb();
    addSession(db, "s1", "/proj");
    addSession(db, "s2", "/proj2");
    const t1 = addTool(db, "s1", "Edit", { input: { file_path: "/proj/a.ts", old_string: "a", new_string: "b" } });
    addTool(db, "s2", "Write", { input: { file_path: "/proj2/b.ts", content: "x" } });
    deriveFileChanges(db);

    // s1's call turns out failed on re-ingest (divergent archive copy) → its row must vanish.
    db.prepare("UPDATE tool_calls SET status = 'error' WHERE id = ?").run(t1);
    deriveFileChanges(db, new Set(["s1"]));
    expect(rowsFor(db, "s1")).toHaveLength(0);
    expect(rowsFor(db, "s2")).toHaveLength(1);
  });
});

describe("deriveFileChanges — shell writes", () => {
  it("derives a row from a heredoc write, with the body's line count", () => {
    const db = freshDb();
    addSession(db, "s", "/proj");
    const t = addTool(db, "s", "Bash", {
      input: { command: "cat > /proj/docs/notes.md <<'EOF'\none\ntwo\nEOF" },
      ts: "2026-07-03T09:00:00Z",
    });
    deriveFileChanges(db);
    expect(rowsFor(db, "s")).toHaveLength(1);
    expect(rowsFor(db, "s")[0]).toMatchObject({
      tool_call_id: t,
      file_path: "/proj/docs/notes.md",
      tool_name: "Bash",
      lines_added: 2,
      lines_removed: null,
      project_id: "p-s",
      timestamp: "2026-07-03T09:00:00Z",
    });
  });

  it("leaves lines unknown for an in-place edit", () => {
    const db = freshDb();
    addSession(db, "s", "/proj");
    addTool(db, "s", "Bash", { input: { command: "sed -i 's/a/b/' /proj/src/x.ts" } });
    expect(deriveFileChanges(db).count).toBe(1);
    expect(rowsFor(db, "s")[0]).toMatchObject({ file_path: "/proj/src/x.ts", lines_added: null });
  });

  it("resolves a relative target against the command's own cd, not the project root", () => {
    const db = freshDb();
    addSession(db, "s", "/proj");
    addTool(db, "s", "Bash", { input: { command: "cd /elsewhere/repo && echo x > out.txt" } });
    deriveFileChanges(db);
    expect(rowsFor(db, "s")[0].file_path).toBe("/elsewhere/repo/out.txt");
  });

  it("resolves a relative target against the project root when the command does not cd", () => {
    const db = freshDb();
    addSession(db, "s", "/proj");
    addTool(db, "s", "Bash", { input: { command: "echo x > src/out.txt" } });
    deriveFileChanges(db);
    expect(rowsFor(db, "s")[0].file_path).toBe("/proj/src/out.txt");
  });

  it("skips a relative target it cannot anchor to any directory", () => {
    const db = freshDb();
    addSession(db, "s"); // no project
    addTool(db, "s", "Bash", { input: { command: "echo x > out.txt" } });
    deriveFileChanges(db);
    expect(rowsFor(db, "s")).toHaveLength(0);
  });

  it("emits one row per file when a command writes several", () => {
    const db = freshDb();
    addSession(db, "s", "/proj");
    addTool(db, "s", "Bash", {
      input: { command: "echo a > /proj/one.txt && sed -i 's/x/y/' /proj/two.ts" },
    });
    deriveFileChanges(db);
    const rows = rowsFor(db, "s");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    expect(rows.map((r) => r.file_path).sort()).toEqual(["/proj/one.txt", "/proj/two.ts"]);
  });

  it("groups a shell write and a tool write of the same file under one path", () => {
    const db = freshDb();
    addSession(db, "s", "/proj");
    addTool(db, "s", "Write", { input: { file_path: "/proj/a.md", content: "x" } });
    addTool(db, "s", "Bash", { input: { command: "echo more >> /proj/a.md" } });
    deriveFileChanges(db);
    const rows = rowsFor(db, "s");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.file_path))).toEqual(new Set(["/proj/a.md"]));
    expect(new Set(rows.map((r) => r.tool_name))).toEqual(new Set(["Write", "Bash"]));
  });
});
