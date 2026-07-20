/**
 * Redacted export endpoint (backlog #3). Seeds a secret-bearing session and asserts the
 * GET /api/sessions/:id/export.md route redacts by default, honors ?redact=structure/off, and
 * names the download to signal whether it was sanitized.
 */
import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "@agent-lens/core";
import { createApp } from "../dist/app.js";

const AKIA = "AKIAIOSFODNN7EXAMPLE";

function seed(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  db.exec(`
    INSERT INTO agents (id, name, kind) VALUES ('claude-code', 'Claude Code CLI', 'cli');
    INSERT INTO sources (id, label, agent_id, config_dir) VALUES ('test', 'test', 'claude-code', NULL);
    INSERT INTO projects (id, agent_id, path, encoded_dir, first_seen, last_seen)
      VALUES ('proj1', 'claude-code', '/home/alice/projects/secret-app', '-home-alice-projects-secret-app', '2026-01-01T00:00:00Z', '2026-01-01T00:10:00Z');
    INSERT INTO sessions (id, agent_id, source_id, project_id, ai_title, is_sidechain, started_at, ended_at, duration_ms, event_count, turn_count)
      VALUES ('sess1', 'claude-code', 'test', 'proj1', 'Deploy to prod', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z', 300000, 1, 1);
    INSERT INTO turns (id, session_id, seq, user_event_uuid, prompt_preview, model, started_at, ended_at, duration_ms)
      VALUES ('sess1:0', 'sess1', 0, 'e1', 'deploy', 'claude-opus-4-8', '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z', 300000);
    INSERT INTO events (uuid, session_id, turn_id, seq, type, role, timestamp, model, is_sidechain, is_meta, text, raw_json)
      VALUES ('e1', 'sess1', 'sess1:0', 0, 'assistant', 'assistant', '2026-01-01T00:01:00Z', 'claude-opus-4-8', 0, 0, 'deploying',
              '{"message":{"content":[{"type":"text","text":"Deploying with key ${AKIA} now"}]}}');
  `);
  return db;
}

let app: Awaited<ReturnType<typeof createApp>>;
beforeAll(async () => {
  app = await createApp(seed());
  await app.ready();
});

const get = (url: string) => app.inject({ method: "GET", url });

describe("GET /api/sessions/:id/export.md", () => {
  it("redacts by default and names the file .redacted.md", async () => {
    const r = await get("/api/sessions/sess1/export.md");
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("[AWS-KEY]");
    expect(r.body).not.toContain(AKIA);
    expect(r.body).toContain("Redacted export");
    expect(r.body).not.toContain("/home/alice");
    expect(r.headers["content-disposition"]).toContain("session-sess1.redacted.md");
  });

  it("?redact=off returns verbatim and names the file plainly", async () => {
    const r = await get("/api/sessions/sess1/export.md?redact=off");
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(AKIA);
    expect(r.body).not.toContain("Redacted export");
    expect(r.headers["content-disposition"]).toContain('session-sess1.md"');
  });

  it("?redact=structure scrubs the narrative", async () => {
    const r = await get("/api/sessions/sess1/export.md?redact=structure");
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain(AKIA);
    expect(r.body).not.toContain("Deploying with key");
    expect(r.body).toContain("[redacted]");
  });

  it("404s an unknown session", async () => {
    const r = await get("/api/sessions/nope/export.md");
    expect(r.statusCode).toBe(404);
  });
});
