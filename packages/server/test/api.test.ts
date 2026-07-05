/**
 * Server smoke tests — build the Fastify app via createApp() over an in-memory DB seeded with a
 * minimal-but-valid graph, and exercise the read-only API with app.inject() (no socket bound).
 */
import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA_SQL, packRaw } from "@agent-lens/core";
import { createApp } from "../dist/app.js";
import { extractParts } from "../dist/db.js";

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
  it("GET /api/health → ok + last_ingested", async () => {
    const r = await app.inject({ method: "GET", url: "/api/health" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.ok).toBe(true);
    // last_ingested is MAX(ingest_state.ingested_at): an ISO string once ingested, null otherwise.
    expect(body).toHaveProperty("last_ingested");
    expect(body.last_ingested === null || typeof body.last_ingested === "string").toBe(true);
  });

  it("POST /api/refresh → blocks a cross-site Origin (CSRF guard) before doing any work", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/refresh",
      headers: { origin: "https://evil.example" },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("FORBIDDEN_ORIGIN");
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

  it("GET /api/sessions?q= → plain term matches", async () => {
    const r = await app.inject({ method: "GET", url: "/api/sessions?q=hello" });
    expect(r.statusCode).toBe(200);
    expect(r.json().sessions[0].id).toBe("sess1");
  });

  it("GET /api/sessions?q=<hyphenated> → 200, input is literal (regression: was SQLITE_ERROR)", async () => {
    // A hyphen/colon was parsed as FTS5 query syntax → `no such column`. Now quoted as a phrase, so
    // "hello-world" matches the adjacent tokens "hello world".
    const r = await app.inject({ method: "GET", url: "/api/sessions?q=" + encodeURIComponent("hello-world") });
    expect(r.statusCode).toBe(200);
    expect(r.json().sessions[0].id).toBe("sess1");
  });

  it("GET /api/sessions?q=<colon/operators> → 200, no FTS syntax error", async () => {
    for (const q of ["foo:bar", "swe-workflow", "a OR b", "-x"]) {
      const r = await app.inject({ method: "GET", url: "/api/sessions?q=" + encodeURIComponent(q) });
      expect(r.statusCode).toBe(200); // literal terms; no match, but never a 500
    }
  });

  it("GET /api/sessions?q=<session name> → matches slug/ai_title, not just transcript text", async () => {
    // "Demo" is the ai_title, and appears in NO event text (events say "hello world"/"hi"), so this
    // only passes because search now also matches the session's own name.
    const r = await app.inject({ method: "GET", url: "/api/sessions?q=Demo" });
    expect(r.statusCode).toBe(200);
    expect(r.json().sessions.map((s: any) => s.id)).toContain("sess1");
  });

  it("GET /api/sessions?q=<project name> → matches the project path", async () => {
    // "proj" is only in the project path (/tmp/proj), never in the transcript.
    const r = await app.inject({ method: "GET", url: "/api/sessions?q=proj" });
    expect(r.statusCode).toBe(200);
    expect(r.json().sessions.map((s: any) => s.id)).toContain("sess1");
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

// Session detail groups workflow fan-out by run: each Workflow tool_call carries a run id + name and
// sits on a turn, and the spawned agents (sessions.workflow_run_id) attribute to it — so the UI can
// show "🔀 <name> · N agents · turn X" instead of one flat, unattributed list.
describe("session detail exposes workflow run grouping", () => {
  it("GET /api/sessions/:id → workflow_runs + children carry workflow_run_id", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    db.exec(`
      INSERT INTO agents (id, name, kind) VALUES ('claude-code', 'Claude Code CLI', 'cli');
      INSERT INTO sources (id, label, agent_id, config_dir) VALUES ('test', 'test', 'claude-code', NULL);
      INSERT INTO sessions (id, agent_id, source_id, is_sidechain, event_count, turn_count) VALUES
        ('orch', 'claude-code', 'test', 0, 2, 1);
      INSERT INTO turns (id, session_id, seq, user_event_uuid, prompt_preview, started_at, ended_at, duration_ms)
        VALUES ('orch:0', 'orch', 0, 'oe1', 'run it', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', 60000);
      INSERT INTO events (uuid, session_id, turn_id, seq, type, role, timestamp, is_sidechain, is_meta, text, raw_json)
        VALUES ('oe1', 'orch', 'orch:0', 0, 'user', 'user', '2026-01-01T00:00:00Z', 0, 0, 'run it', '{"message":{"content":"run it"}}'),
               ('oe2', 'orch', 'orch:0', 1, 'assistant', 'assistant', '2026-01-01T00:00:30Z', 0, 0, NULL, '{"message":{"content":[]}}');
      INSERT INTO tool_calls (id, event_uuid, session_id, turn_id, tool_name, workflow_run_id, workflow_name)
        VALUES ('tu_wf', 'oe2', 'orch', 'orch:0', 'Workflow', 'wf_run1', 'my-flow');
      INSERT INTO sessions (id, agent_id, source_id, is_sidechain, workflow_run_id, parent_session_id, parent_turn_id, event_count, turn_count) VALUES
        ('agent-x', 'claude-code', 'test', 1, 'wf_run1', 'orch', 'orch:0', 1, 1),
        ('agent-y', 'claude-code', 'test', 1, 'wf_run1', 'orch', 'orch:0', 1, 1);
    `);
    const app2 = await createApp(db);
    await app2.ready();
    const body = (await app2.inject({ method: "GET", url: "/api/sessions/orch" })).json();
    expect(body.workflow_runs).toHaveLength(1);
    expect(body.workflow_runs[0]).toMatchObject({ run_id: "wf_run1", name: "my-flow", turn_seq: 0, agent_count: 2 });
    expect(body.children).toHaveLength(2);
    expect(body.children.every((c: any) => c.workflow_run_id === "wf_run1")).toBe(true);
    // The launching Workflow tool_call exposes its run for the transcript block.
    const wfTool = body.events.flatMap((e: any) => e.toolCalls).find((t: any) => t.tool_name === "Workflow");
    expect(wfTool.workflow_name).toBe("my-flow");
    expect(wfTool.workflow_agent_count).toBe(2);
    await app2.close();
  });
});

// The workflow detail endpoint (/api/workflows/:run_id) backs the workflow detail page: it resolves
// the launching Workflow tool_call (name, parent crumb) and the agents fanned out under the run id,
// with roll-up stats.
describe("workflow detail endpoint", () => {
  async function appWithRun() {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    db.exec(`
      INSERT INTO agents (id, name, kind) VALUES ('claude-code', 'Claude Code CLI', 'cli');
      INSERT INTO sources (id, label, agent_id, config_dir) VALUES ('test', 'test', 'claude-code', NULL);
      INSERT INTO sessions (id, agent_id, source_id, ai_title, is_sidechain, event_count, turn_count) VALUES
        ('orch', 'claude-code', 'test', 'Orchestrator', 0, 2, 1);
      INSERT INTO turns (id, session_id, seq, user_event_uuid, prompt_preview, started_at, ended_at, duration_ms)
        VALUES ('orch:0', 'orch', 0, 'oe1', 'run it', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', 60000);
      INSERT INTO events (uuid, session_id, turn_id, seq, type, role, timestamp, is_sidechain, is_meta, text, raw_json)
        VALUES ('oe2', 'orch', 'orch:0', 1, 'assistant', 'assistant', '2026-01-01T00:00:30Z', 0, 0, NULL, '{"message":{"content":[]}}');
      INSERT INTO events (uuid, session_id, turn_id, seq, type, role, timestamp, is_sidechain, is_meta, text, raw_json)
        VALUES ('oe3', 'orch', 'orch:0', 2, 'user', 'user', '2026-01-01T00:02:00Z', 0, 0,
                '<task-notification><tool-use-id>tu_wf</tool-use-id><status>completed</status><summary>flow done</summary><result>{"ok":true}</result><failures>none</failures></task-notification>',
                '{"message":{"content":"<task-notification><tool-use-id>tu_wf</tool-use-id><status>completed</status><summary>flow done</summary><result>{\\"ok\\":true}</result><failures>none</failures></task-notification>"}}');
      INSERT INTO tool_calls (id, event_uuid, session_id, turn_id, tool_name, workflow_run_id, workflow_name, status, result_summary, input_json)
        VALUES ('tu_wf', 'oe2', 'orch', 'orch:0', 'Workflow', 'wf_run1', 'my-flow', 'async_launched', 'all done', '{"description":"do the thing","args":"[{\\"skill\\":\\"a\\"}]"}');
      INSERT INTO sessions (id, agent_id, source_id, ai_title, is_sidechain, workflow_run_id, parent_session_id, parent_turn_id, started_at, ended_at, event_count, turn_count) VALUES
        ('agent-x', 'claude-code', 'test', 'Agent X', 1, 'wf_run1', 'orch', 'orch:0', '2026-01-01T00:00:40Z', '2026-01-01T00:00:50Z', 1, 1),
        ('agent-y', 'claude-code', 'test', 'Agent Y', 1, 'wf_run1', 'orch', 'orch:0', '2026-01-01T00:00:45Z', '2026-01-01T00:01:10Z', 1, 1);
    `);
    const app2 = await createApp(db);
    await app2.ready();
    return app2;
  }

  it("GET /api/workflows/:run_id → name, parent crumb, agents + stats", async () => {
    const app2 = await appWithRun();
    const r = await app2.inject({ method: "GET", url: "/api/workflows/wf_run1" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ run_id: "wf_run1", name: "my-flow", status: "async_launched", result_summary: "all done" });
    // The launch payload is exposed so the page can render it (LaunchView) for async runs.
    expect(body.input_json).toContain('"description":"do the thing"');
    expect(body.parent).toMatchObject({ id: "orch", title: "Orchestrator", turn_seq: 0 });
    expect(body.agents.map((a: any) => a.id).sort()).toEqual(["agent-x", "agent-y"]);
    expect(body.stats.agent_count).toBe(2);
    // Wall-clock span = earliest start (00:00:40) → latest end (00:01:10) = 30s.
    expect(body.stats.duration_ms).toBe(30000);
    // The completion comes from the <task-notification>, not the launch ack (result_summary).
    expect(body.completion).toMatchObject({ status: "completed", summary: "flow done", result: '{"ok":true}', failures: "none" });
    await app2.close();
  });

  it("GET /api/workflows/:run_id → 404 for unknown run", async () => {
    const app2 = await appWithRun();
    const r = await app2.inject({ method: "GET", url: "/api/workflows/nope" });
    expect(r.statusCode).toBe(404);
    await app2.close();
  });

  it("prefers the result sidecar (workflow_results) over the transcript notification", async () => {
    // Seed a Workflow tool_call (async_launched, no completion notification) plus the ingested result
    // sidecar for the same run; the sidecar must supply status + completion + the run roll-up.
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    db.exec(`
      INSERT INTO agents (id, name, kind) VALUES ('claude-code', 'Claude Code CLI', 'cli');
      INSERT INTO sources (id, label, agent_id, config_dir) VALUES ('test', 'test', 'claude-code', NULL);
      INSERT INTO sessions (id, agent_id, source_id, ai_title, is_sidechain, event_count, turn_count) VALUES ('orch', 'claude-code', 'test', 'Orchestrator', 0, 1, 1);
      INSERT INTO turns (id, session_id, seq, user_event_uuid) VALUES ('orch:0', 'orch', 0, 'oe1');
      INSERT INTO events (uuid, session_id, turn_id, seq, type, role, timestamp, is_sidechain, is_meta, raw_json)
        VALUES ('oe2', 'orch', 'orch:0', 1, 'assistant', 'assistant', '2026-01-01T00:00:30Z', 0, 0, '{"message":{"content":[]}}');
      INSERT INTO tool_calls (id, event_uuid, session_id, turn_id, tool_name, workflow_run_id, workflow_name, status)
        VALUES ('tu_wf', 'oe2', 'orch', 'orch:0', 'Workflow', 'wf_side', 'my-flow', 'async_launched');
      INSERT INTO workflow_results (run_id, source_id, session_id, task_id, workflow_name, status, summary, default_model, result_json, phases_json, logs_json, agent_count, total_tokens, total_tool_calls, duration_ms, started_at, ended_at, ingested_at)
        VALUES ('wf_side', 'test', 'orch', 'tk1', 'my-flow', 'completed', 'evals done', 'claude-fable-5',
                '{"total":{"green":5}}', '[{"title":"Generate"},{"title":"Judge"}]', '["a: GREEN 5/5"]', 12, 500, 24, 5000, '2026-01-01T00:00:00Z', '2026-01-01T00:00:05Z', 'now');
    `);
    const app3 = await createApp(db);
    await app3.ready();
    const r = await app3.inject({ method: "GET", url: "/api/workflows/wf_side" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.status).toBe("completed"); // sidecar status, not the async_launched tool_call status
    expect(body.completion).toMatchObject({ status: "completed", summary: "evals done", result: '{"total":{"green":5}}' });
    expect(body.run).toMatchObject({ default_model: "claude-fable-5", agent_count: 12, total_tool_calls: 24, duration_ms: 5000 });
    expect(body.run.phases.map((p: any) => p.title)).toEqual(["Generate", "Judge"]);
    expect(body.run.logs).toEqual(["a: GREEN 5/5"]);
    await app3.close();
  });
});

// raw_json is stored gzip-compressed (ADR-011); the transcript read path must transparently decode it,
// while still tolerating legacy plain rows written before the migration.
describe("extractParts decodes stored raw_json (ADR-011)", () => {
  it("decompresses a gzip BLOB into text + thinking", () => {
    const line = JSON.stringify({
      message: { content: [{ type: "text", text: "hi" }, { type: "thinking", thinking: "hmm" }] },
    });
    const { text, thinking } = extractParts(packRaw(line));
    expect(text).toBe("hi");
    expect(thinking).toBe("hmm");
  });

  it("still reads a legacy plain-string raw_json", () => {
    const { text } = extractParts('{"message":{"content":"plain"}}');
    expect(text).toBe("plain");
  });
});

// Subagent metadata (session_meta) enriches both fan-out views: a subagent's authoritative type +
// human description + nesting depth, LEFT JOINed onto the children/agents projections.
describe("session_meta enriches subagent + workflow-agent rows", () => {
  it("GET /api/sessions/:id → children carry agent_type/agent_description/spawn_depth", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    db.exec(`
      INSERT INTO agents (id, name, kind) VALUES ('claude-code', 'Claude Code CLI', 'cli');
      INSERT INTO sources (id, label, agent_id, config_dir) VALUES ('test', 'test', 'claude-code', NULL);
      INSERT INTO sessions (id, agent_id, source_id, is_sidechain, event_count, turn_count) VALUES
        ('orch', 'claude-code', 'test', 0, 1, 1);
      INSERT INTO sessions (id, agent_id, source_id, is_sidechain, parent_session_id, event_count, turn_count) VALUES
        ('agent-a', 'claude-code', 'test', 1, 'orch', 1, 1),
        ('agent-b', 'claude-code', 'test', 1, 'orch', 1, 1);
      -- meta present for agent-a (typed + described + nested), absent for agent-b (still lists).
      INSERT INTO session_meta (session_id, source_id, agent_type, agent_description, spawn_depth, tool_use_id, ingested_at)
        VALUES ('agent-a', 'test', 'Explore', 'Explore the ingest pipeline', 2, 'toolu_1', 'now');
    `);
    const app2 = await createApp(db);
    await app2.ready();
    const body = (await app2.inject({ method: "GET", url: "/api/sessions/orch" })).json();
    const a = body.children.find((c: any) => c.id === "agent-a");
    const b = body.children.find((c: any) => c.id === "agent-b");
    expect(a).toMatchObject({ agent_type: "Explore", agent_description: "Explore the ingest pipeline", spawn_depth: 2 });
    expect(b).toMatchObject({ agent_type: null, agent_description: null, spawn_depth: null });
    await app2.close();
  });

  it("GET /api/workflows/:run_id → agents carry meta fields", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    db.exec(`
      INSERT INTO agents (id, name, kind) VALUES ('claude-code', 'Claude Code CLI', 'cli');
      INSERT INTO sources (id, label, agent_id, config_dir) VALUES ('test', 'test', 'claude-code', NULL);
      INSERT INTO sessions (id, agent_id, source_id, ai_title, is_sidechain, event_count, turn_count) VALUES ('orch', 'claude-code', 'test', 'Orch', 0, 1, 1);
      INSERT INTO turns (id, session_id, seq, user_event_uuid) VALUES ('orch:0', 'orch', 0, 'oe1');
      INSERT INTO events (uuid, session_id, turn_id, seq, type, role, timestamp, is_sidechain, is_meta, raw_json)
        VALUES ('oe2', 'orch', 'orch:0', 1, 'assistant', 'assistant', '2026-01-01T00:00:30Z', 0, 0, '{"message":{"content":[]}}');
      INSERT INTO tool_calls (id, event_uuid, session_id, turn_id, tool_name, workflow_run_id, workflow_name, status)
        VALUES ('tu_wf', 'oe2', 'orch', 'orch:0', 'Workflow', 'wf_run1', 'my-flow', 'async_launched');
      INSERT INTO sessions (id, agent_id, source_id, is_sidechain, workflow_run_id, started_at, event_count, turn_count) VALUES
        ('agent-x', 'claude-code', 'test', 1, 'wf_run1', '2026-01-01T00:00:40Z', 1, 1);
      INSERT INTO session_meta (session_id, source_id, agent_type, agent_description, spawn_depth, tool_use_id, ingested_at)
        VALUES ('agent-x', 'test', 'ai-evaluation', 'gen-red for ai-evaluation', NULL, 'toolu_2', 'now');
    `);
    const app2 = await createApp(db);
    await app2.ready();
    const body = (await app2.inject({ method: "GET", url: "/api/workflows/wf_run1" })).json();
    expect(body.agents[0]).toMatchObject({ id: "agent-x", agent_type: "ai-evaluation", agent_description: "gen-red for ai-evaluation" });
    await app2.close();
  });
});

// Spilled tool outputs (tool_results): when a tool result_summary is the "Full output saved to:
// …/tool-results/<name>.txt" marker, getSession attaches the un-truncated text so the UI can expand it.
describe("getSession attaches spilled full tool results", () => {
  it("GET /api/sessions/:id → tool call with a truncation marker gets full_result", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    db.exec(`
      INSERT INTO agents (id, name, kind) VALUES ('claude-code', 'Claude Code CLI', 'cli');
      INSERT INTO sources (id, label, agent_id, config_dir) VALUES ('test', 'test', 'claude-code', NULL);
      INSERT INTO sessions (id, agent_id, source_id, is_sidechain, event_count, turn_count) VALUES ('sess1', 'claude-code', 'test', 0, 1, 1);
      INSERT INTO turns (id, session_id, seq, user_event_uuid) VALUES ('sess1:0', 'sess1', 0, 'e1');
      INSERT INTO events (uuid, session_id, turn_id, seq, type, role, timestamp, is_sidechain, is_meta, raw_json)
        VALUES ('e2', 'sess1', 'sess1:0', 1, 'assistant', 'assistant', '2026-01-01T00:00:30Z', 0, 0, '{"message":{"content":[]}}');
      INSERT INTO tool_calls (id, event_uuid, session_id, turn_id, tool_name, result_summary) VALUES
        ('tc_big', 'e2', 'sess1', 'sess1:0', 'Bash', 'Output too large (32.1KB). Full output saved to: /home/u/.claude/projects/-x/sess1/tool-results/bk7e5i18g.txt Preview (first 2KB): …'),
        ('tc_small', 'e2', 'sess1', 'sess1:0', 'Bash', 'ok, small result');
      INSERT INTO tool_results (session_id, name, path, bytes, text, ingested_at)
        VALUES ('sess1', 'bk7e5i18g', '/archive/.../tool-results/bk7e5i18g.txt', 32900, 'THE FULL UNTRUNCATED OUTPUT', 'now');
    `);
    const app2 = await createApp(db);
    await app2.ready();
    const body = (await app2.inject({ method: "GET", url: "/api/sessions/sess1" })).json();
    const tools = body.events.flatMap((e: any) => e.toolCalls);
    const big = tools.find((t: any) => t.id === "tc_big");
    const small = tools.find((t: any) => t.id === "tc_small");
    expect(big.full_result).toMatchObject({ text: "THE FULL UNTRUNCATED OUTPUT", bytes: 32900 });
    expect(small.full_result).toBeUndefined(); // no marker → no lookup
    await app2.close();
  });
});

// Schema-version drift: /api/health flags a DB stamped by an older build so the UI can warn that a full
// re-ingest is required (an incremental ingest can't migrate a schema bump).
describe("health surfaces schema staleness", () => {
  it("GET /api/health → schema_stale true when meta.schema_version mismatches the build", async () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '1')").run(); // ancient stamp
    const app2 = await createApp(db);
    await app2.ready();
    const body = (await app2.inject({ method: "GET", url: "/api/health" })).json();
    expect(body.schema_version).toBe(1);
    expect(body.schema_stale).toBe(true);
    await app2.close();
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
