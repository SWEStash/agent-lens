/**
 * Agent Lens — dashboard aggregation queries (Phase 4). Read-only; everything is computed as
 * server-side aggregates (GROUP BY over indexed columns) so the charts plot bounded series, not
 * raw rows — this is what lets the UI scale to years of data. Token series are always kept split
 * (input / output / cache-creation / cache-read); cache-read is never folded into a single
 * "tokens" number because it dominates and misleads. Cost is derived via the shared pricing table.
 */
import { costForUsage, rateForModel } from "@agent-lens/core";
import type { DB } from "./db.js";

export interface DashFilters {
  source?: string;
  from?: string;
  to?: string;
}

/** WHERE clause + params over the `sessions` alias `s` (started_at / source_id). */
function sessionWhere(f: DashFilters): { sql: string; params: any[] } {
  const where: string[] = [];
  const params: any[] = [];
  if (f.source) (where.push("s.source_id = ?"), params.push(f.source));
  // Date-inclusive on both ends (compare the DATE part) so a picked `to` day includes that day's
  // events — a plain `started_at <= '2026-07-14'` would drop everything after 2026-07-14T00:00.
  if (f.from) (where.push("date(s.started_at) >= date(?)"), params.push(f.from));
  if (f.to) (where.push("date(s.started_at) <= date(?)"), params.push(f.to));
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

interface Split {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
}
const zeroSplit = (): Split => ({ input: 0, output: 0, cache_creation: 0, cache_read: 0 });

/** Sum a grouped usage row into a split accumulator. */
function addUsage(acc: Split, r: any) {
  acc.input += r.i ?? 0;
  acc.output += r.o ?? 0;
  acc.cache_creation += r.cw ?? 0;
  acc.cache_read += r.cr ?? 0;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)]!;
}

export function dashboardOverview(db: DB, f: DashFilters) {
  const w = sessionWhere(f);

  const counts = db
    .prepare(
      `SELECT
         COUNT(*) sessions,
         SUM(CASE WHEN is_sidechain=0 THEN 1 ELSE 0 END) main,
         SUM(CASE WHEN is_sidechain=1 THEN 1 ELSE 0 END) subagent,
         SUM(turn_count) turns,
         COUNT(DISTINCT project_id) projects
       FROM sessions s ${w.sql}`,
    )
    .get(...w.params) as any;

  const toolCount = (
    db
      .prepare(`SELECT COUNT(*) n FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id ${w.sql}`)
      .get(...w.params) as any
  ).n;

  // Per-model usage → token split + cache-aware cost; track unpriced models honestly.
  const usage = db
    .prepare(
      `SELECT t.model model, SUM(t.input_tokens) i, SUM(t.output_tokens) o,
              SUM(t.cache_creation_input_tokens) cw, SUM(t.cache_read_input_tokens) cr
       FROM token_usage t JOIN sessions s ON s.id = t.session_id ${w.sql}
       GROUP BY t.model`,
    )
    .all(...w.params) as any[];
  const tokens = zeroSplit();
  let cost = 0;
  const unpriced: string[] = [];
  for (const u of usage) {
    addUsage(tokens, u);
    cost += costForUsage(u.model, { input_tokens: u.i, output_tokens: u.o, cache_creation_input_tokens: u.cw, cache_read_input_tokens: u.cr });
    if (u.model && !rateForModel(u.model) && (u.i || u.o || u.cw || u.cr)) unpriced.push(u.model);
  }
  const totalTokens = tokens.input + tokens.output + tokens.cache_creation + tokens.cache_read;

  // Turn-duration percentiles (work cadence), excluding null durations.
  const durs = (
    db
      .prepare(
        `SELECT tn.duration_ms d FROM turns tn JOIN sessions s ON s.id = tn.session_id
         ${w.sql ? w.sql + " AND" : "WHERE"} tn.duration_ms IS NOT NULL ORDER BY tn.duration_ms`,
      )
      .all(...w.params) as any[]
  ).map((r) => r.d as number);

  return {
    range: { from: f.from ?? null, to: f.to ?? null, source: f.source ?? null },
    sessions: counts.sessions ?? 0,
    sessions_main: counts.main ?? 0,
    sessions_subagent: counts.subagent ?? 0,
    turns: counts.turns ?? 0,
    projects: counts.projects ?? 0,
    tool_calls: toolCount ?? 0,
    tokens, // {input, output, cache_creation, cache_read}
    total_tokens: totalTokens,
    cache_read_ratio: totalTokens ? tokens.cache_read / totalTokens : 0,
    cost: Number(cost.toFixed(4)),
    unpriced_models: [...new Set(unpriced)].sort(),
    turn_duration_ms: { p50: pct(durs, 50), p95: pct(durs, 95), count: durs.length },
  };
}

type Bucket = "day" | "week" | "month";

/** Pick a bucket so the series stays small regardless of how wide the range is. */
function chooseBucket(db: DB, f: DashFilters): Bucket {
  const w = sessionWhere(f);
  const r = db
    .prepare(`SELECT MIN(started_at) mn, MAX(started_at) mx FROM sessions s ${w.sql}`)
    .get(...w.params) as any;
  if (!r?.mn || !r?.mx) return "day";
  const spanDays = (Date.parse(r.mx) - Date.parse(r.mn)) / 86_400_000;
  if (spanDays <= 92) return "day";
  if (spanDays <= 730) return "week";
  return "month";
}

const BUCKET_EXPR: Record<Bucket, string> = {
  day: "strftime('%Y-%m-%d', s.started_at)",
  week: "strftime('%Y-W%W', s.started_at)",
  month: "strftime('%Y-%m', s.started_at)",
};

export function dashboardTimeseries(db: DB, f: DashFilters, bucketParam?: string) {
  const bucket: Bucket = bucketParam === "day" || bucketParam === "week" || bucketParam === "month" ? bucketParam : chooseBucket(db, f);
  const w = sessionWhere(f);
  const expr = BUCKET_EXPR[bucket];

  type Row = { bucket: string } & Split & { cost: number; sessions: number; turns: number };
  const byBucket = new Map<string, Row>();
  const get = (b: string): Row => {
    let r = byBucket.get(b);
    if (!r) {
      r = { bucket: b, ...zeroSplit(), cost: 0, sessions: 0, turns: 0 };
      byBucket.set(b, r);
    }
    return r;
  };

  for (const u of db
    .prepare(
      `SELECT ${expr} b, t.model model, SUM(t.input_tokens) i, SUM(t.output_tokens) o,
              SUM(t.cache_creation_input_tokens) cw, SUM(t.cache_read_input_tokens) cr
       FROM token_usage t JOIN sessions s ON s.id = t.session_id
       ${w.sql} GROUP BY b, t.model`,
    )
    .all(...w.params) as any[]) {
    if (!u.b) continue;
    const r = get(u.b);
    addUsage(r, u);
    r.cost += costForUsage(u.model, { input_tokens: u.i, output_tokens: u.o, cache_creation_input_tokens: u.cw, cache_read_input_tokens: u.cr });
  }
  for (const s of db.prepare(`SELECT ${expr} b, COUNT(*) n FROM sessions s ${w.sql} GROUP BY b`).all(...w.params) as any[]) {
    if (s.b) get(s.b).sessions = s.n;
  }
  for (const t of db
    .prepare(`SELECT ${expr} b, COUNT(*) n FROM turns tn JOIN sessions s ON s.id = tn.session_id ${w.sql} GROUP BY b`)
    .all(...w.params) as any[]) {
    if (t.b) get(t.b).turns = t.n;
  }

  const series = [...byBucket.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
  for (const r of series) r.cost = Number(r.cost.toFixed(4));
  return { bucket, series };
}

export function dashboardBreakdowns(db: DB, f: DashFilters) {
  const w = sessionWhere(f);

  const modelRows = db
    .prepare(
      `SELECT t.model model, SUM(t.input_tokens) i, SUM(t.output_tokens) o,
              SUM(t.cache_creation_input_tokens) cw, SUM(t.cache_read_input_tokens) cr,
              COUNT(DISTINCT t.session_id) sessions
       FROM token_usage t JOIN sessions s ON s.id = t.session_id ${w.sql}
       GROUP BY t.model ORDER BY (SUM(t.input_tokens)+SUM(t.output_tokens)+SUM(t.cache_creation_input_tokens)+SUM(t.cache_read_input_tokens)) DESC`,
    )
    .all(...w.params) as any[];
  const byModel = modelRows.map((u) => ({
    model: u.model,
    tokens: { input: u.i ?? 0, output: u.o ?? 0, cache_creation: u.cw ?? 0, cache_read: u.cr ?? 0 },
    total_tokens: (u.i ?? 0) + (u.o ?? 0) + (u.cw ?? 0) + (u.cr ?? 0),
    cost: Number(costForUsage(u.model, { input_tokens: u.i, output_tokens: u.o, cache_creation_input_tokens: u.cw, cache_read_input_tokens: u.cr }).toFixed(4)),
    sessions: u.sessions ?? 0,
    priced: !!rateForModel(u.model),
  }));

  const bySource = db
    .prepare(
      `SELECT COALESCE(s.source_id, '(none)') source, COUNT(*) sessions, SUM(s.turn_count) turns
       FROM sessions s ${w.sql} GROUP BY s.source_id ORDER BY sessions DESC`,
    )
    .all(...w.params);

  // Category / complexity over MAIN sessions only (subagents inherit the parent's task).
  const mainW = { sql: w.sql ? w.sql + " AND s.is_sidechain = 0" : "WHERE s.is_sidechain = 0", params: w.params };
  const byCategory = db
    .prepare(
      `SELECT c.category, COUNT(*) n FROM classifications c JOIN sessions s ON s.id = c.target_id
       ${mainW.sql} GROUP BY c.category ORDER BY n DESC`,
    )
    .all(...mainW.params);
  const byComplexity = db
    .prepare(
      `SELECT c.complexity_band band, COUNT(*) n FROM classifications c JOIN sessions s ON s.id = c.target_id
       ${mainW.sql} GROUP BY c.complexity_band ORDER BY n DESC`,
    )
    .all(...mainW.params);

  const tools = db
    .prepare(
      `SELECT tc.tool_name name, COUNT(*) n FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id
       ${w.sql} GROUP BY tc.tool_name ORDER BY n DESC LIMIT 20`,
    )
    .all(...w.params);

  const skills = db
    .prepare(
      `SELECT tc.skill_name name, COUNT(*) n FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id
       ${w.sql ? w.sql + " AND" : "WHERE"} tc.skill_name IS NOT NULL GROUP BY tc.skill_name ORDER BY n DESC LIMIT 20`,
    )
    .all(...w.params);

  // Per-version breakdown for the grouped skill bar chart: each captured version's firing count,
  // with the version id + its last-seen time so the chart can stack/hover and deep-link to
  // /skill/:name?v=<id>. Same source/from/to filter as the by-name `skills` query above.
  const skillVersions = db
    .prepare(
      `SELECT tc.skill_name name, sk.id version_id, sk.summary, sk.last_seen, COUNT(*) n
       FROM tool_calls tc
       JOIN skills sk ON sk.id = tc.skill_id
       JOIN sessions s ON s.id = tc.session_id
       ${w.sql ? w.sql + " AND" : "WHERE"} tc.skill_id IS NOT NULL
       GROUP BY tc.skill_name, sk.id ORDER BY name, n DESC`,
    )
    .all(...w.params);

  // Subagent fan-out: spawns by type, plus a per-(main-)session histogram of subagent calls.
  const subagentByType = db
    .prepare(
      `SELECT tc.agent_type type, COUNT(*) n FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id
       ${w.sql ? w.sql + " AND" : "WHERE"} tc.agent_type IS NOT NULL GROUP BY tc.agent_type ORDER BY n DESC`,
    )
    .all(...w.params);
  const perSession = db
    .prepare(
      `SELECT COUNT(*) n FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id
       ${w.sql ? w.sql + " AND" : "WHERE"} s.is_sidechain = 0 AND tc.tool_name IN ('Agent','Task')
       GROUP BY tc.session_id`,
    )
    .all(...w.params) as any[];
  const counts = perSession.map((r) => r.n as number);
  const subagentFanout = {
    by_type: subagentByType,
    sessions_with_subagents: counts.length,
    total_spawns: counts.reduce((a, b) => a + b, 0),
    max_per_session: counts.length ? Math.max(...counts) : 0,
    avg_per_session: counts.length ? Number((counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(2)) : 0,
  };

  return { by_model: byModel, by_source: bySource, by_category: byCategory, by_complexity: byComplexity, tools, skills, skill_versions: skillVersions, subagent_fanout: subagentFanout };
}
