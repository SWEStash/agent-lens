/**
 * Seed factories for the server tests.
 *
 * Every suite here needs a valid-enough slice of the session graph, and hand-written `db.exec` string
 * blobs made that ~60 near-identical INSERTs (SLOP-042) — impossible to see what a given test actually
 * depends on. These are prepared statements with defaults instead, so a test states only the columns
 * its assertion rests on. Same pattern as packages/ingest/test/detect.test.ts.
 *
 * Foreign keys are ON by default (the API reads across the graph and a broken join should fail loudly);
 * pass `{ foreignKeys: false }` to seed a partial graph deliberately.
 */
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "@agent-lens/core";
import { createApp } from "../../dist/app.js";

export const AGENT = "claude-code";
export const SOURCE = "test";

/** A fresh in-memory DB with the schema applied and one agent + one source, which everything else FKs to. */
export function freshDb(opts: { foreignKeys?: boolean; source?: string } = {}): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec(`PRAGMA foreign_keys = ${opts.foreignKeys === false ? "OFF" : "ON"}`);
  db.prepare("INSERT INTO agents (id, name, kind) VALUES (?, 'Claude Code CLI', 'cli')").run(AGENT);
  addSource(db, opts.source ?? SOURCE);
  return db;
}

export function addSource(db: DatabaseSync, id: string, label = id) {
  db.prepare("INSERT INTO sources (id, label, agent_id, config_dir) VALUES (?, ?, ?, NULL)").run(id, label, AGENT);
}

export function addProject(db: DatabaseSync, id: string, path: string, encodedDir = path.replace(/\//g, "-")) {
  db.prepare(
    `INSERT INTO projects (id, agent_id, path, encoded_dir, first_seen, last_seen)
     VALUES (?, ?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:10:00Z')`,
  ).run(id, AGENT, path, encodedDir);
}

export interface SessionOpts {
  source?: string;
  project?: string | null;
  title?: string | null;
  sidechain?: boolean;
  startedAt?: string | null;
  endedAt?: string | null;
  durationMs?: number | null;
  events?: number;
  turns?: number;
  parent?: string | null;
  parentTurn?: string | null;
  workflowRun?: string | null;
}

export function addSession(db: DatabaseSync, id: string, o: SessionOpts = {}) {
  db.prepare(
    `INSERT INTO sessions (id, agent_id, source_id, project_id, ai_title, is_sidechain, started_at, ended_at,
                           duration_ms, event_count, turn_count, parent_session_id, parent_turn_id, workflow_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    AGENT,
    o.source ?? SOURCE,
    o.project ?? null,
    o.title ?? null,
    o.sidechain ? 1 : 0,
    o.startedAt ?? null,
    o.endedAt ?? null,
    o.durationMs ?? null,
    o.events ?? 1,
    o.turns ?? 1,
    o.parent ?? null,
    o.parentTurn ?? null,
    o.workflowRun ?? null,
  );
}

/** Seed a turn. Returns its id, which is the `<session>:<seq>` convention the rest of the graph uses. */
export function addTurn(
  db: DatabaseSync,
  session: string,
  seq: number,
  o: { userEvent?: string; preview?: string | null; model?: string | null; startedAt?: string | null; endedAt?: string | null; durationMs?: number | null } = {},
): string {
  const id = `${session}:${seq}`;
  db.prepare(
    `INSERT INTO turns (id, session_id, seq, user_event_uuid, prompt_preview, model, started_at, ended_at, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, session, seq, o.userEvent ?? `${id}:u`, o.preview ?? null, o.model ?? null, o.startedAt ?? null, o.endedAt ?? null, o.durationMs ?? null);
  return id;
}

export interface EventOpts {
  turn?: string | null;
  seq?: number;
  type?: string;
  role?: string;
  timestamp?: string;
  model?: string | null;
  text?: string | null;
  /** Raw transcript line. Defaults to a minimal envelope carrying `text`; pass a Buffer for packed raw. */
  raw?: string | Buffer;
  meta?: boolean;
  sidechain?: boolean;
}

export function addEvent(db: DatabaseSync, session: string, uuid: string, o: EventOpts = {}) {
  const role = o.role ?? o.type ?? "assistant";
  const raw =
    o.raw ??
    JSON.stringify(role === "user" ? { message: { content: o.text ?? "" } } : { message: { content: o.text ? [{ type: "text", text: o.text }] : [] } });
  db.prepare(
    `INSERT INTO events (uuid, session_id, turn_id, seq, type, role, timestamp, model, is_sidechain, is_meta, text, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuid,
    session,
    o.turn ?? null,
    o.seq ?? 0,
    o.type ?? role,
    role,
    o.timestamp ?? "2026-01-01T00:00:00Z",
    o.model ?? null,
    o.sidechain ? 1 : 0,
    o.meta ? 1 : 0,
    o.text ?? null,
    raw,
  );
}

export interface ToolOpts {
  turn?: string | null;
  input?: unknown;
  /** Pass a raw string to seed malformed JSON deliberately. */
  inputRaw?: string;
  result?: string | null;
  status?: string | null;
  skill?: string | null;
  agentType?: string | null;
  spawned?: string | null;
  workflowRun?: string | null;
  workflowName?: string | null;
}

export function addTool(db: DatabaseSync, session: string, event: string, id: string, tool: string, o: ToolOpts = {}) {
  db.prepare(
    `INSERT INTO tool_calls (id, event_uuid, session_id, turn_id, tool_name, input_json, result_summary, status,
                             skill_name, agent_type, spawned_session_id, workflow_run_id, workflow_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    event,
    session,
    o.turn ?? null,
    tool,
    o.inputRaw ?? (o.input != null ? JSON.stringify(o.input) : null),
    o.result ?? null,
    o.status ?? null,
    o.skill ?? null,
    o.agentType ?? null,
    o.spawned ?? null,
    o.workflowRun ?? null,
    o.workflowName ?? null,
  );
}

export function addTokens(
  db: DatabaseSync,
  event: string,
  session: string,
  model: string,
  t: { input?: number; output?: number; cacheCreate?: number; cacheRead?: number; turn?: string | null } = {},
) {
  db.prepare(
    `INSERT INTO token_usage (event_uuid, session_id, turn_id, model, input_tokens, output_tokens,
                              cache_creation_input_tokens, cache_read_input_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(event, session, t.turn ?? null, model, t.input ?? 0, t.output ?? 0, t.cacheCreate ?? 0, t.cacheRead ?? 0);
}

/** Build + start the Fastify app over `db`. Callers close it; `app.inject()` binds no socket. */
export async function appFor(db: DatabaseSync, opts?: Parameters<typeof createApp>[1]) {
  const app = await createApp(db, opts);
  await app.ready();
  return app;
}

/**
 * The graph most API tests want: one project, one main session with a turn, a user + assistant event,
 * token usage, and a Skill tool call. Mirrors the original hand-written `seed()` exactly so the
 * assertions built on it (total_tokens 150, "Demo session", the test-suite-design skill) still hold.
 */
export function seedBasic(): DatabaseSync {
  const db = freshDb();
  addProject(db, "proj1", "/tmp/proj", "-tmp-proj");
  addSession(db, "sess1", {
    project: "proj1",
    title: "Demo session",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:05:00Z",
    durationMs: 300000,
    events: 2,
    turns: 1,
  });
  const turn = addTurn(db, "sess1", 0, {
    userEvent: "e1",
    preview: "hello world",
    model: "claude-opus-4-8",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:05:00Z",
    durationMs: 300000,
  });
  addEvent(db, "sess1", "e1", { turn, seq: 0, role: "user", timestamp: "2026-01-01T00:00:00Z", text: "hello world" });
  addEvent(db, "sess1", "e2", { turn, seq: 1, role: "assistant", timestamp: "2026-01-01T00:05:00Z", model: "claude-opus-4-8", text: "hi" });
  addTokens(db, "e2", "sess1", "claude-opus-4-8", { input: 100, output: 50, turn });
  addTool(db, "sess1", "e2", "tc1", "Skill", { turn, skill: "test-suite-design" });
  return db;
}
