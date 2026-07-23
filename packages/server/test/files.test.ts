/**
 * File-provenance endpoints (ADR-022) — /api/files, /api/file, and the session detail's embedded
 * file_changes. Same harness as api.test.ts: createApp() over an in-memory seeded DB, app.inject().
 */
import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "@agent-lens/core";
import { createApp } from "../dist/app.js";

function seed(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  db.exec(`
    INSERT INTO agents (id, name, kind) VALUES ('claude-code', 'Claude Code CLI', 'cli');
    INSERT INTO sources (id, label, agent_id, config_dir) VALUES ('test', 'test', 'claude-code', NULL);
    INSERT INTO projects (id, agent_id, path) VALUES ('proj1', 'claude-code', '/tmp/proj');
    INSERT INTO projects (id, agent_id, path) VALUES ('proj2', 'claude-code', '/tmp/other');
    INSERT INTO sessions (id, agent_id, source_id, project_id, ai_title, started_at, event_count, turn_count)
      VALUES ('sess1', 'claude-code', 'test', 'proj1', 'First session', '2026-01-01T00:00:00Z', 2, 1),
             ('sess2', 'claude-code', 'test', 'proj1', 'Second session', '2026-01-02T00:00:00Z', 2, 1),
             ('sess3', 'claude-code', 'test', 'proj2', 'Other project', '2026-01-03T00:00:00Z', 2, 1);
    INSERT INTO turns (id, session_id, seq, prompt_preview) VALUES
      ('sess1:0', 'sess1', 0, 'add feature'), ('sess2:0', 'sess2', 0, 'fix bug'), ('sess3:0', 'sess3', 0, 'other');
    INSERT INTO events (uuid, session_id, turn_id, type, timestamp, raw_json) VALUES
      ('e1', 'sess1', 'sess1:0', 'assistant', '2026-01-01T00:01:00Z', x'00'),
      ('e2', 'sess2', 'sess2:0', 'assistant', '2026-01-02T00:01:00Z', x'00'),
      ('e3', 'sess3', 'sess3:0', 'assistant', '2026-01-03T00:01:00Z', x'00');
    INSERT INTO tool_calls (id, event_uuid, session_id, turn_id, tool_name) VALUES
      ('tc1', 'e1', 'sess1', 'sess1:0', 'Edit'),
      ('tc2', 'e2', 'sess2', 'sess2:0', 'Write'),
      ('tc3', 'e3', 'sess3', 'sess3:0', 'Edit');
    INSERT INTO file_changes (id, tool_call_id, session_id, turn_id, event_uuid, project_id, file_path, tool_name, lines_added, lines_removed, timestamp) VALUES
      ('fc1', 'tc1', 'sess1', 'sess1:0', 'e1', 'proj1', '/tmp/proj/src/a.ts', 'Edit', 3, 1, '2026-01-01T00:01:00Z'),
      ('fc2', 'tc2', 'sess2', 'sess2:0', 'e2', 'proj1', '/tmp/proj/src/a.ts', 'Write', 10, NULL, '2026-01-02T00:01:00Z'),
      ('fc3', 'tc3', 'sess3', 'sess3:0', 'e3', 'proj2', '/tmp/other/b.md', 'Edit', 1, 1, '2026-01-03T00:01:00Z');
  `);
  return db;
}

let app: Awaited<ReturnType<typeof createApp>>;
beforeAll(async () => {
  app = await createApp(seed());
  await app.ready();
});

describe("GET /api/files", () => {
  it("aggregates per (project, file) with counts, line totals, and paging shape", async () => {
    const r = await app.inject({ method: "GET", url: "/api/files" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.total).toBe(2);
    // default sort: last_ts desc → the proj2 file (Jan 3) leads
    expect(body.files[0]).toMatchObject({ file_path: "/tmp/other/b.md", project_path: "/tmp/other", sessions: 1, changes: 1 });
    expect(body.files[1]).toMatchObject({
      file_path: "/tmp/proj/src/a.ts",
      sessions: 2,
      changes: 2,
      lines_added: 13,
      lines_removed: 1,
      first_ts: "2026-01-01T00:01:00Z",
      last_ts: "2026-01-02T00:01:00Z",
    });
  });

  it("filters by path substring and project; paginates", async () => {
    const q = await app.inject({ method: "GET", url: "/api/files?q=a.ts" });
    expect(q.json().files.map((f: any) => f.file_path)).toEqual(["/tmp/proj/src/a.ts"]);

    const p = await app.inject({ method: "GET", url: "/api/files?project=proj2" });
    expect(p.json().files.map((f: any) => f.file_path)).toEqual(["/tmp/other/b.md"]);

    const paged = await app.inject({ method: "GET", url: "/api/files?limit=1&offset=1&sort=path&dir=asc" });
    expect(paged.json()).toMatchObject({ total: 2 });
    expect(paged.json().files.map((f: any) => f.file_path)).toEqual(["/tmp/proj/src/a.ts"]);
  });
});

describe("GET /api/file", () => {
  it("returns the timeline grouped by session, newest-changing session first", async () => {
    const r = await app.inject({ method: "GET", url: "/api/file?path=" + encodeURIComponent("/tmp/proj/src/a.ts") });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({
      file_path: "/tmp/proj/src/a.ts",
      project_path: "/tmp/proj",
      sessions_count: 2,
      changes_count: 2,
      lines_added: 13,
      lines_removed: 1,
    });
    expect(body.sessions.map((s: any) => s.session_id)).toEqual(["sess2", "sess1"]);
    expect(body.sessions[1].changes[0]).toMatchObject({
      event_uuid: "e1",
      tool_name: "Edit",
      turn_seq: 0,
      prompt_preview: "add feature",
    });
  });

  it("404s an unknown path and 400s a missing one", async () => {
    expect((await app.inject({ method: "GET", url: "/api/file?path=/nope" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/file" })).statusCode).toBe(400);
  });
});

describe("session detail embeds file_changes", () => {
  it("GET /api/sessions/:id carries the session's file changes", async () => {
    const r = await app.inject({ method: "GET", url: "/api/sessions/sess1" });
    expect(r.statusCode).toBe(200);
    expect(r.json().file_changes).toEqual([
      expect.objectContaining({ file_path: "/tmp/proj/src/a.ts", tool_name: "Edit", event_uuid: "e1", lines_added: 3, lines_removed: 1 }),
    ]);
  });
});

describe("pre-v14 DB degradation (no file_changes table)", () => {
  it("serves empty list / 404 / empty session field instead of 500", async () => {
    const db = seed();
    db.exec("DROP TABLE file_changes");
    const old = await createApp(db);
    await old.ready();
    expect((await old.inject({ method: "GET", url: "/api/files" })).json()).toEqual({ total: 0, files: [] });
    expect((await old.inject({ method: "GET", url: "/api/file?path=/x" })).statusCode).toBe(404);
    expect((await old.inject({ method: "GET", url: "/api/sessions/sess1" })).json().file_changes).toEqual([]);
  });
});
