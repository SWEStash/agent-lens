/**
 * Server smoke tests — build the Fastify app via createApp() over an in-memory DB seeded with a
 * minimal-but-valid graph, and exercise the read-only API with app.inject() (no socket bound).
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
    INSERT INTO projects (id, agent_id, path, encoded_dir, first_seen, last_seen)
      VALUES ('proj1', 'claude-code', '/tmp/proj', '-tmp-proj', '2026-01-01T00:00:00Z', '2026-01-01T00:10:00Z');
    INSERT INTO sessions (id, agent_id, source_id, project_id, ai_title, is_sidechain, started_at, ended_at, duration_ms, event_count, turn_count)
      VALUES ('sess1', 'claude-code', 'test', 'proj1', 'Demo session', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z', 300000, 2, 1);
    INSERT INTO turns (id, session_id, seq, user_event_uuid, prompt_preview, model, started_at, ended_at, duration_ms)
      VALUES ('sess1:0', 'sess1', 0, 'e1', 'hello world', 'claude-opus-4-8', '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z', 300000);
    INSERT INTO events (uuid, session_id, turn_id, seq, type, role, timestamp, model, is_sidechain, is_meta, text, raw_json)
      VALUES ('e1', 'sess1', 'sess1:0', 0, 'user', 'user', '2026-01-01T00:00:00Z', NULL, 0, 0, 'hello world',
              '{"message":{"content":"hello world"}}');
    INSERT INTO events (uuid, session_id, turn_id, seq, type, role, timestamp, model, is_sidechain, is_meta, text, raw_json)
      VALUES ('e2', 'sess1', 'sess1:0', 1, 'assistant', 'assistant', '2026-01-01T00:05:00Z', 'claude-opus-4-8', 0, 0, 'hi',
              '{"message":{"content":[{"type":"text","text":"hi"}]}}');
    INSERT INTO token_usage (event_uuid, session_id, turn_id, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens)
      VALUES ('e2', 'sess1', 'sess1:0', 'claude-opus-4-8', 100, 50, 0, 0);
    INSERT INTO tool_calls (id, event_uuid, session_id, turn_id, tool_name, skill_name)
      VALUES ('tc1', 'e2', 'sess1', 'sess1:0', 'Skill', 'test-suite-design');
  `);
  return db;
}

let app: Awaited<ReturnType<typeof createApp>>;

beforeAll(async () => {
  app = await createApp(seed());
  await app.ready();
});

describe("server API smoke", () => {
  it("GET /api/health → ok", async () => {
    const r = await app.inject({ method: "GET", url: "/api/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it("GET /api/sessions → paginated list", async () => {
    const r = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.total).toBe(1);
    expect(body.sessions[0].id).toBe("sess1");
    expect(body.sessions[0].title).toBe("Demo session");
  });

  it("GET /api/sessions/:id → transcript detail", async () => {
    const r = await app.inject({ method: "GET", url: "/api/sessions/sess1" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.session.id).toBe("sess1");
    expect(body.turns.length).toBe(1);
    expect(body.events.length).toBe(2);
    expect(body.parent).toBeNull(); // main session, no spawning parent
  });

  it("GET /api/sessions/:id → 404 for unknown id", async () => {
    const r = await app.inject({ method: "GET", url: "/api/sessions/nope" });
    expect(r.statusCode).toBe(404);
  });

  it("GET /api/dashboard/overview → aggregates", async () => {
    const r = await app.inject({ method: "GET", url: "/api/dashboard/overview" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.sessions).toBe(1);
    expect(body.total_tokens).toBe(150);
  });

  it("GET /api/dashboard/breakdowns → includes skills", async () => {
    const r = await app.inject({ method: "GET", url: "/api/dashboard/breakdowns" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.skills.some((s: any) => s.name === "test-suite-design")).toBe(true);
  });
});

// The source-filter dropdown shows "(N)" next to each source. N must be MAIN sessions only — the list
// it filters defaults to main-only, and each task spawns many subagent sidechains, so counting all
// sessions wildly inflates it (the reported 327-vs-27 bug).
describe("source session_count counts main sessions only", () => {
  it("GET /api/sources → excludes subagent sidechains", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    db.exec(`
      INSERT INTO agents (id, name, kind) VALUES ('claude-code', 'Claude Code CLI', 'cli');
      INSERT INTO sources (id, label, agent_id, config_dir) VALUES ('isf', 'isf', 'claude-code', NULL);
      INSERT INTO sessions (id, agent_id, source_id, is_sidechain, event_count, turn_count) VALUES
        ('m1', 'claude-code', 'isf', 0, 3, 1),
        ('a1', 'claude-code', 'isf', 1, 2, 1),
        ('a2', 'claude-code', 'isf', 1, 2, 1),
        ('a3', 'claude-code', 'isf', 1, 2, 1);
    `);
    const app2 = await createApp(db);
    await app2.ready();
    const r = await app2.inject({ method: "GET", url: "/api/sources" });
    expect(r.statusCode).toBe(200);
    const src = r.json().find((s: any) => s.id === "isf");
    expect(src.session_count).toBe(1); // 1 main, not 4 (3 subagents excluded)
    await app2.close();
  });
});
