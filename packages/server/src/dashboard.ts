/**
 * Agent Lens — dashboard aggregation queries. Read-only; everything is computed as
 * server-side aggregates (GROUP BY over indexed columns) so the charts plot bounded series, not
 * raw rows — this is what lets the UI scale to years of data. Token series are always kept split
 * (input / output / cache-creation / cache-read); cache-read is never folded into a single
 * "tokens" number because it dominates and misleads. Cost is derived via the shared pricing table.
 */
import { costForUsage, rateForModel, errorKind, type ToolErrorType } from "@agent-lens/core";
import type { DashBreakdowns, DashOverview, DashTimeseries, TimeseriesPoint } from "@agent-lens/contracts";
import type { DB } from "./db.js";
import { tableExists, pushDateRange, queryAll, queryGet } from "./sql-util.js";
import type {
  BucketCountRow,
  BucketErrorRow,
  BucketUsageAggRow,
  CountRow,
  ModelBreakdownRow,
  OverviewCountsRow,
  SpanRow,
  UsageAggRow,
  WorkflowStatusAggRow,
} from "./rows.js";

export interface DashFilters {
  source?: string;
  from?: string;
  to?: string;
}

/** A WHERE-clause fragment and its bound parameters, threaded through every aggregate below. */
type Where = { sql: string; params: unknown[] };

/** WHERE clause + params over the `sessions` alias `s` (started_at / source_id). */
function sessionWhere(f: DashFilters): Where {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.source) (where.push("s.source_id = ?"), params.push(f.source));
  // Date-inclusive on both ends (compare the DATE part) so a picked `to` day includes that day's
  // events — a plain `started_at <= '2026-07-14'` would drop everything after 2026-07-14T00:00.
  pushDateRange(where, params, "s.started_at", f.from, f.to);
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
function addUsage(acc: Split, r: UsageAggRow) {
  acc.input += r.i ?? 0;
  acc.output += r.o ?? 0;
  acc.cache_creation += r.cw ?? 0;
  acc.cache_read += r.cr ?? 0;
}

/** The per-model cost arguments, unpacked from a usage aggregate's short SQL aliases. */
const usageForCost = (u: UsageAggRow) => ({
  input_tokens: u.i ?? 0,
  output_tokens: u.o ?? 0,
  cache_creation_input_tokens: u.cw ?? 0,
  cache_read_input_tokens: u.cr ?? 0,
});

/**
 * p50/p95 (nearest-rank) plus the sample size, computed **in SQL**.
 *
 * `values` is a `SELECT <expr> v FROM …` returning one row per observation, unordered; this wraps it
 * in a CTE and picks the ranked element with `LIMIT 1 OFFSET`. It used to pull every duration into JS
 * and sort there — one row per turn, per request, growing with the corpus forever.
 *
 * The offset is `ceil(p/100 × n) - 1` floored at 0, which is exactly the rank the previous JS
 * `pct()` selected, so stored percentiles do not shift. An empty set yields 0 (the CTE returns NULL,
 * coalesced), also matching the old behaviour.
 */
function percentiles(db: DB, values: string, params: unknown[]): { p50: number; p95: number; count: number } {
  const at = (p: number) =>
    `(SELECT COALESCE((SELECT v FROM vals ORDER BY v
        LIMIT 1 OFFSET MAX(0, CAST(ceil(${p} / 100.0 * (SELECT c FROM n)) AS INTEGER) - 1)), 0))`;
  const row = queryGet<{ p50: number; p95: number; count: number }>(
    db,
    // MATERIALIZED matters: the three selects below each reference `vals`, and without the hint
    // SQLite inlines the CTE and re-runs the underlying scan once per percentile.
    `WITH vals AS MATERIALIZED (${values}), n AS (SELECT COUNT(*) c FROM vals)
     SELECT ${at(50)} AS p50, ${at(95)} AS p95, (SELECT c FROM n) AS count`,
    ...params,
  );
  return row ?? { p50: 0, p95: 0, count: 0 };
}

/** WHERE over `workflow_results` own columns (its own source_id / started_at, not the sessions alias). */
function workflowWhere(f: DashFilters): Where {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.source) (where.push("source_id = ?"), params.push(f.source));
  pushDateRange(where, params, "started_at", f.from, f.to);
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

/** Aggregate the async-workflow runs (schema v9+): counts by status, success rate over decided runs
 * (completed vs failed; in-flight `running` excluded from the denominator), and token/duration rollups.
 * Guarded so a pre-v9 DB (no `workflow_results` table) returns an all-zero shape instead of throwing. */
function workflowAgg(db: DB, f: DashFilters): DashOverview["workflows"] {
  const empty = { total: 0, by_status: [], completed: 0, failed: 0, success_rate: 0, total_tokens: 0, avg_duration_ms: 0 };
  if (!tableExists(db, "workflow_results")) return empty;
  const ww = workflowWhere(f);
  const rows = queryAll<WorkflowStatusAggRow>(
    db,
    `SELECT COALESCE(status, '(unknown)') status, COUNT(*) n,
            SUM(COALESCE(total_tokens, 0)) tokens,
            SUM(COALESCE(duration_ms, 0)) dur,
            SUM(CASE WHEN duration_ms IS NOT NULL THEN 1 ELSE 0 END) dur_n
     FROM workflow_results ${ww.sql} GROUP BY status ORDER BY n DESC`,
    ...ww.params,
  );
  let total = 0, completed = 0, failed = 0, tokens = 0, durSum = 0, durN = 0;
  const by_status = rows.map((r) => {
    total += r.n;
    if (r.status === "completed") completed += r.n;
    else if (r.status === "failed") failed += r.n;
    tokens += r.tokens ?? 0;
    durSum += r.dur ?? 0;
    durN += r.dur_n ?? 0;
    return { status: r.status, n: r.n };
  });
  const decided = completed + failed;
  return {
    total,
    by_status,
    completed,
    failed,
    success_rate: decided ? completed / decided : 0,
    total_tokens: tokens,
    avg_duration_ms: durN ? Math.round(durSum / durN) : 0,
  };
}

export function dashboardOverview(db: DB, f: DashFilters): DashOverview {
  const w = sessionWhere(f);

  const counts = queryGet<OverviewCountsRow>(
    db,
    `SELECT
       COUNT(*) sessions,
       SUM(CASE WHEN is_sidechain=0 THEN 1 ELSE 0 END) main,
       SUM(CASE WHEN is_sidechain=1 THEN 1 ELSE 0 END) subagent,
       SUM(turn_count) turns,
       COUNT(DISTINCT project_id) projects
     FROM sessions s ${w.sql}`,
    ...w.params,
  )!;

  const toolCount = queryGet<CountRow>(
    db,
    `SELECT COUNT(*) n FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id ${w.sql}`,
    ...w.params,
  )!.n;

  // Per-model usage → token split + cache-aware cost; track unpriced models honestly.
  const usage = queryAll<UsageAggRow>(
    db,
    `SELECT t.model model, SUM(t.input_tokens) i, SUM(t.output_tokens) o,
            SUM(t.cache_creation_input_tokens) cw, SUM(t.cache_read_input_tokens) cr
     FROM token_usage t JOIN sessions s ON s.id = t.session_id ${w.sql}
     GROUP BY t.model`,
    ...w.params,
  );
  const tokens = zeroSplit();
  let cost = 0;
  const unpriced: string[] = [];
  for (const u of usage) {
    addUsage(tokens, u);
    cost += costForUsage(u.model, usageForCost(u));
    if (u.model && !rateForModel(u.model) && (u.i || u.o || u.cw || u.cr)) unpriced.push(u.model);
  }
  const totalTokens = tokens.input + tokens.output + tokens.cache_creation + tokens.cache_read;

  // Turn-duration percentiles (work cadence), excluding null durations.
  const turnDur = percentiles(
    db,
    `SELECT tn.duration_ms v FROM turns tn JOIN sessions s ON s.id = tn.session_id
     ${w.sql ? w.sql + " AND" : "WHERE"} tn.duration_ms IS NOT NULL`,
    w.params,
  );

  // Session-length percentiles over MAIN sessions only (subagents share the parent's wall clock),
  // excluding null durations. Complements the per-turn cadence with an end-to-end task-length view.
  const sessDur = percentiles(
    db,
    `SELECT s.duration_ms v FROM sessions s
     ${w.sql ? w.sql + " AND" : "WHERE"} s.is_sidechain = 0 AND s.duration_ms IS NOT NULL`,
    w.params,
  );

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
    turn_duration_ms: turnDur,
    session_duration_ms: sessDur,
    workflows: workflowAgg(db, f),
  };
}

type Bucket = "day" | "week" | "month";

/** Pick a bucket so the series stays small regardless of how wide the range is. */
function chooseBucket(db: DB, f: DashFilters): Bucket {
  const w = sessionWhere(f);
  const r = queryGet<SpanRow>(db, `SELECT MIN(started_at) mn, MAX(started_at) mx FROM sessions s ${w.sql}`, ...w.params);
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

export function dashboardTimeseries(db: DB, f: DashFilters, bucketParam?: string): DashTimeseries {
  const bucket: Bucket = bucketParam === "day" || bucketParam === "week" || bucketParam === "month" ? bucketParam : chooseBucket(db, f);
  const w = sessionWhere(f);
  const expr = BUCKET_EXPR[bucket];

  const byBucket = new Map<string, TimeseriesPoint>();
  const get = (b: string): TimeseriesPoint => {
    let r = byBucket.get(b);
    if (!r) {
      r = { bucket: b, ...zeroSplit(), cost: 0, sessions: 0, turns: 0, failures: 0, rejections: 0 };
      byBucket.set(b, r);
    }
    return r;
  };

  for (const u of queryAll<BucketUsageAggRow>(
    db,
    `SELECT ${expr} b, t.model model, SUM(t.input_tokens) i, SUM(t.output_tokens) o,
            SUM(t.cache_creation_input_tokens) cw, SUM(t.cache_read_input_tokens) cr
     FROM token_usage t JOIN sessions s ON s.id = t.session_id
     ${w.sql} GROUP BY b, t.model`,
    ...w.params,
  )) {
    if (!u.b) continue;
    const r = get(u.b);
    addUsage(r, u);
    r.cost += costForUsage(u.model, usageForCost(u));
  }
  for (const s of queryAll<BucketCountRow>(db, `SELECT ${expr} b, COUNT(*) n FROM sessions s ${w.sql} GROUP BY b`, ...w.params)) {
    if (s.b) get(s.b).sessions = s.n;
  }
  for (const t of queryAll<BucketCountRow>(
    db,
    `SELECT ${expr} b, COUNT(*) n FROM turns tn JOIN sessions s ON s.id = tn.session_id ${w.sql} GROUP BY b`,
    ...w.params,
  )) {
    if (t.b) get(t.b).turns = t.n;
  }
  // Errored tool calls per bucket, split into genuine failures vs user/guardrail rejections (kind
  // derived from the stored error_type). Bucketed by the session's date, same as every other series.
  for (const e of queryAll<BucketErrorRow>(
    db,
    `SELECT ${expr} b, tc.error_type et, COUNT(*) n FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id
     ${w.sql ? w.sql + " AND" : "WHERE"} tc.status = 'error' GROUP BY b, tc.error_type`,
    ...w.params,
  )) {
    if (!e.b) continue;
    const r = get(e.b);
    if (e.et && errorKind(e.et as ToolErrorType) === "rejection") r.rejections += e.n;
    else r.failures += e.n;
  }

  const series = [...byBucket.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
  for (const r of series) r.cost = Number(r.cost.toFixed(4));
  return { bucket, series };
}

/** Extend a session WHERE clause with one more condition, opening the clause when it is empty. */
const andWhere = (w: Where) => (w.sql ? w.sql + " AND" : "WHERE");

function modelBreakdown(db: DB, w: Where): DashBreakdowns["by_model"] {
  const modelRows = queryAll<ModelBreakdownRow>(
    db,
    // COALESCE the bucket label, exactly as by_source does for a null source_id: token_usage.model is
    // nullable and this GROUP BY — unlike the model FILTER list — does not exclude nulls, so a
    // null-model bucket reaches the chart. It used to render as a nameless bar.
    `SELECT COALESCE(t.model, '(unknown)') model, SUM(t.input_tokens) i, SUM(t.output_tokens) o,
            SUM(t.cache_creation_input_tokens) cw, SUM(t.cache_read_input_tokens) cr,
            COUNT(DISTINCT t.session_id) sessions
     FROM token_usage t JOIN sessions s ON s.id = t.session_id ${w.sql}
     GROUP BY t.model ORDER BY (SUM(t.input_tokens)+SUM(t.output_tokens)+SUM(t.cache_creation_input_tokens)+SUM(t.cache_read_input_tokens)) DESC`,
    ...w.params,
  );
  return modelRows.map((u) => ({
    model: u.model,
    tokens: { input: u.i ?? 0, output: u.o ?? 0, cache_creation: u.cw ?? 0, cache_read: u.cr ?? 0 },
    total_tokens: (u.i ?? 0) + (u.o ?? 0) + (u.cw ?? 0) + (u.cr ?? 0),
    cost: Number(costForUsage(u.model, usageForCost(u)).toFixed(4)),
    sessions: u.sessions ?? 0,
    priced: !!rateForModel(u.model),
  }));
}

function sourceBreakdown(db: DB, w: Where): DashBreakdowns["by_source"] {
  return queryAll<DashBreakdowns["by_source"][number]>(
    db,
    `SELECT COALESCE(s.source_id, '(none)') source, COUNT(*) sessions, SUM(s.turn_count) turns
     FROM sessions s ${w.sql} GROUP BY s.source_id ORDER BY sessions DESC`,
    ...w.params,
  );
}

/** Category + complexity over MAIN sessions only (subagents inherit the parent's task). */
function classificationBreakdowns(db: DB, w: Where): {
  byCategory: DashBreakdowns["by_category"];
  byComplexity: DashBreakdowns["by_complexity"];
} {
  const mainW: Where = { sql: w.sql ? w.sql + " AND s.is_sidechain = 0" : "WHERE s.is_sidechain = 0", params: w.params };
  const byCategory = queryAll<DashBreakdowns["by_category"][number]>(
    db,
    `SELECT c.category, COUNT(*) n FROM classifications c JOIN sessions s ON s.id = c.target_id
     ${mainW.sql} GROUP BY c.category ORDER BY n DESC`,
    ...mainW.params,
  );
  const byComplexity = queryAll<DashBreakdowns["by_complexity"][number]>(
    db,
    `SELECT c.complexity_band band, COUNT(*) n FROM classifications c JOIN sessions s ON s.id = c.target_id
     ${mainW.sql} GROUP BY c.complexity_band ORDER BY n DESC`,
    ...mainW.params,
  );
  return { byCategory, byComplexity };
}

function toolBreakdown(db: DB, w: Where): DashBreakdowns["tools"] {
  return queryAll<DashBreakdowns["tools"][number]>(
    db,
    `SELECT tc.tool_name name, COUNT(*) n FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id
     ${w.sql} GROUP BY tc.tool_name ORDER BY n DESC LIMIT 20`,
    ...w.params,
  );
}

/** Skill firings by name, plus the per-version breakdown for the grouped skill bar chart: each
 * captured version's firing count, with the version id + its last-seen time so the chart can
 * stack/hover and deep-link to /skill/:name?v=<id>. Both share the same source/from/to filter. */
function skillBreakdowns(db: DB, w: Where): {
  skills: DashBreakdowns["skills"];
  skillVersions: DashBreakdowns["skill_versions"];
} {
  const skills = queryAll<DashBreakdowns["skills"][number]>(
    db,
    `SELECT tc.skill_name name, COUNT(*) n FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id
     ${andWhere(w)} tc.skill_name IS NOT NULL GROUP BY tc.skill_name ORDER BY n DESC LIMIT 20`,
    ...w.params,
  );

  const skillVersions = queryAll<DashBreakdowns["skill_versions"][number]>(
    db,
    `SELECT tc.skill_name name, sk.id version_id, sk.summary, sk.last_seen, COUNT(*) n
     FROM tool_calls tc
     JOIN skills sk ON sk.id = tc.skill_id
     JOIN sessions s ON s.id = tc.session_id
     ${andWhere(w)} tc.skill_id IS NOT NULL
     GROUP BY tc.skill_name, sk.id ORDER BY name, n DESC`,
    ...w.params,
  );

  return { skills, skillVersions };
}

/** Subagent fan-out: spawns by type, plus a per-(main-)session histogram of subagent calls. */
function subagentFanoutBreakdown(db: DB, w: Where): DashBreakdowns["subagent_fanout"] {
  const subagentByType = queryAll<DashBreakdowns["subagent_fanout"]["by_type"][number]>(
    db,
    `SELECT tc.agent_type type, COUNT(*) n FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id
     ${andWhere(w)} tc.agent_type IS NOT NULL GROUP BY tc.agent_type ORDER BY n DESC`,
    ...w.params,
  );
  const perSession = queryAll<CountRow>(
    db,
    `SELECT COUNT(*) n FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id
     ${andWhere(w)} s.is_sidechain = 0 AND tc.tool_name IN ('Agent','Task')
     GROUP BY tc.session_id`,
    ...w.params,
  );
  const counts = perSession.map((r) => r.n);
  return {
    by_type: subagentByType,
    sessions_with_subagents: counts.length,
    total_spawns: counts.reduce((a, b) => a + b, 0),
    max_per_session: counts.length ? Math.max(...counts) : 0,
    avg_per_session: counts.length ? Number((counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(2)) : 0,
  };
}

/** Errored tool calls by heuristic error_type, with failures-vs-rejections totals. error_type is
 * populated only for status='error' rows (see errors.ts); the raw count is authoritative, the bucket
 * is the heuristic. Ordered most-frequent first. */
function errorTypeBreakdown(db: DB, w: Where): DashBreakdowns["error_types"] {
  const errorRows = queryAll<{ type: string; n: number }>(
    db,
    `SELECT COALESCE(tc.error_type, 'other') type, COUNT(*) n FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id
     ${andWhere(w)} tc.status = 'error' GROUP BY tc.error_type ORDER BY n DESC`,
    ...w.params,
  );
  let failures = 0;
  let rejections = 0;
  const byType = errorRows.map((r) => {
    // See the note in db.ts's withSessionTotals: a stored bucket name need not still be one of the
    // ToolErrorType literals, and errorKind answers "failure" for anything it doesn't recognize.
    const kind = errorKind(r.type as ToolErrorType);
    if (kind === "rejection") rejections += r.n;
    else failures += r.n;
    return { type: r.type, kind, n: r.n };
  });
  return { by_type: byType, failures, rejections };
}

export function dashboardBreakdowns(db: DB, f: DashFilters): DashBreakdowns {
  const w = sessionWhere(f);
  const { byCategory, byComplexity } = classificationBreakdowns(db, w);
  const { skills, skillVersions } = skillBreakdowns(db, w);

  return {
    by_model: modelBreakdown(db, w),
    by_source: sourceBreakdown(db, w),
    by_category: byCategory,
    by_complexity: byComplexity,
    tools: toolBreakdown(db, w),
    skills,
    skill_versions: skillVersions,
    subagent_fanout: subagentFanoutBreakdown(db, w),
    error_types: errorTypeBreakdown(db, w),
  };
}
