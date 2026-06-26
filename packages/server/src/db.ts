import Database from "better-sqlite3";
import { costForUsage } from "@agent-lens/core";

export type DB = Database.Database;

export function openReadonly(file: string): DB {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  return db;
}

/** Split a raw transcript line's message content into natural text vs thinking. */
export function extractParts(rawJson: string): { text: string | null; thinking: string | null } {
  let text = "";
  let thinking = "";
  try {
    const content = JSON.parse(rawJson)?.message?.content;
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "text" && typeof b.text === "string") text += (text ? "\n" : "") + b.text;
        else if (b?.type === "thinking" && typeof b.thinking === "string")
          thinking += (thinking ? "\n" : "") + b.thinking;
      }
    }
  } catch {
    /* ignore */
  }
  return { text: text || null, thinking: thinking || null };
}

export interface SessionFilters {
  source?: string;
  project?: string;
  model?: string;
  q?: string;
  from?: string;
  to?: string;
  kind?: "main" | "subagent";
  limit: number;
  offset: number;
}

export function listSources(db: DB) {
  return db
    .prepare(
      `SELECT s.id, s.label, s.agent_id, s.config_dir,
              (SELECT COUNT(*) FROM sessions x WHERE x.source_id = s.id) AS session_count
       FROM sources s ORDER BY s.label`,
    )
    .all();
}

export function listProjects(db: DB) {
  return db
    .prepare(
      `SELECT p.id, p.path,
              (SELECT COUNT(*) FROM sessions x WHERE x.project_id = p.id) AS session_count
       FROM projects p ORDER BY session_count DESC, p.path`,
    )
    .all();
}

export function listModels(db: DB) {
  return db
    .prepare(`SELECT DISTINCT model FROM token_usage WHERE model IS NOT NULL ORDER BY model`)
    .all()
    .map((r: any) => r.model);
}

export function listSessions(db: DB, f: SessionFilters) {
  const where: string[] = [];
  const params: any[] = [];
  if (f.source) (where.push("s.source_id = ?"), params.push(f.source));
  if (f.project) (where.push("s.project_id = ?"), params.push(f.project));
  if (f.from) (where.push("s.started_at >= ?"), params.push(f.from));
  if (f.to) (where.push("s.started_at <= ?"), params.push(f.to));
  if (f.kind === "main") where.push("s.is_sidechain = 0");
  if (f.kind === "subagent") where.push("s.is_sidechain = 1");
  if (f.model) {
    where.push("EXISTS (SELECT 1 FROM token_usage t WHERE t.session_id = s.id AND t.model = ?)");
    params.push(f.model);
  }
  if (f.q && f.q.trim()) {
    where.push(
      "s.id IN (SELECT DISTINCT e.session_id FROM events e JOIN events_fts f ON f.rowid = e.rowid WHERE events_fts MATCH ?)",
    );
    params.push(f.q.trim());
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = (db.prepare(`SELECT COUNT(*) n FROM sessions s ${whereSql}`).get(...params) as any).n;

  const rows = db
    .prepare(
      `SELECT s.id, s.ai_title, s.slug, s.source_id, s.is_sidechain, s.started_at, s.ended_at,
              s.duration_ms, s.event_count, s.turn_count, p.path AS project_path,
              (SELECT GROUP_CONCAT(DISTINCT model) FROM token_usage t WHERE t.session_id = s.id) AS models
       FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
       ${whereSql}
       ORDER BY s.started_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, f.limit, f.offset) as any[];

  // Cost + tokens per session for this page (grouped by model so rates apply correctly).
  const ids = rows.map((r) => r.id);
  const costBySession = new Map<string, { tokens: number; cost: number }>();
  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    const usage = db
      .prepare(
        `SELECT session_id, model,
                SUM(input_tokens) i, SUM(output_tokens) o,
                SUM(cache_creation_input_tokens) cw, SUM(cache_read_input_tokens) cr
         FROM token_usage WHERE session_id IN (${ph}) GROUP BY session_id, model`,
      )
      .all(...ids) as any[];
    for (const u of usage) {
      const acc = costBySession.get(u.session_id) ?? { tokens: 0, cost: 0 };
      acc.tokens += u.i + u.o + u.cw + u.cr;
      acc.cost += costForUsage(u.model, {
        input_tokens: u.i,
        output_tokens: u.o,
        cache_creation_input_tokens: u.cw,
        cache_read_input_tokens: u.cr,
      });
      costBySession.set(u.session_id, acc);
    }
  }
  for (const r of rows) {
    const c = costBySession.get(r.id);
    r.tokens = c?.tokens ?? 0;
    r.cost = c ? Number(c.cost.toFixed(4)) : 0;
    r.title = r.ai_title || r.slug || null;
  }

  return { total, sessions: rows };
}

export function getSession(db: DB, id: string) {
  const session = db
    .prepare(
      `SELECT s.*, p.path AS project_path FROM sessions s
       LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = ?`,
    )
    .get(id) as any;
  if (!session) return null;

  const turns = db.prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY seq").all(id);
  const eventRows = db
    .prepare(
      `SELECT uuid, type, role, timestamp, model, is_sidechain, turn_id, raw_json
       FROM events WHERE session_id = ? ORDER BY timestamp, seq`,
    )
    .all(id) as any[];
  const toolRows = db
    .prepare(
      `SELECT event_uuid, tool_name, skill_name, agent_type, status, total_duration_ms, total_tokens,
              input_json, result_summary FROM tool_calls WHERE session_id = ?`,
    )
    .all(id) as any[];
  const toolsByEvent = new Map<string, any[]>();
  for (const t of toolRows) {
    if (!t.event_uuid) continue;
    (toolsByEvent.get(t.event_uuid) ?? toolsByEvent.set(t.event_uuid, []).get(t.event_uuid))!.push(t);
  }

  const events = eventRows.map((e) => {
    const { text, thinking } = extractParts(e.raw_json);
    return {
      uuid: e.uuid,
      type: e.type,
      role: e.role,
      timestamp: e.timestamp,
      model: e.model,
      is_sidechain: e.is_sidechain,
      turn_id: e.turn_id,
      text,
      thinking,
      toolCalls: toolsByEvent.get(e.uuid) ?? [],
    };
  });

  const usage = db
    .prepare(
      `SELECT model, SUM(input_tokens) i, SUM(output_tokens) o,
              SUM(cache_creation_input_tokens) cw, SUM(cache_read_input_tokens) cr
       FROM token_usage WHERE session_id = ? GROUP BY model`,
    )
    .all(id) as any[];
  let tokens = 0;
  let cost = 0;
  for (const u of usage) {
    tokens += u.i + u.o + u.cw + u.cr;
    cost += costForUsage(u.model, {
      input_tokens: u.i,
      output_tokens: u.o,
      cache_creation_input_tokens: u.cw,
      cache_read_input_tokens: u.cr,
    });
  }
  session.tokens = tokens;
  session.cost = Number(cost.toFixed(4));
  session.title = session.ai_title || session.slug || null;

  return { session, turns, events };
}
