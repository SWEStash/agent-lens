/** The paged, filtered, sortable session list (GET /api/sessions). */
import { activePricing, canonicalModel } from "@agent-lens/core";
import type { SessionSummary, SessionsPage, SessionSort } from "@agent-lens/contracts";
import { canonModelSql, queryAll, queryGet, orderBy, pushDateRange, placeholders, whereClause, enumValues, type SortDir } from "../sql-util.js";
import type { CountRow, SessionListRow } from "../rows.js";
import { usageBySession, splitOf, tokensOf, costOf, unpricedOf } from "../usage.js";
import { type DB, SESSION_MODELS_SQL, displayTitle, severityRankSql } from "./common.js";

// The values this endpoint accepts for `?sort=`. The union lives in @agent-lens/contracts so the web
// views share it; this is the runtime allowlist app.ts parses the query against, checked against
// the union in both directions by enumValues.
export const SESSION_SORTS = enumValues<SessionSort>({
  started: true, title: true, turns: true, tokens: true, cost: true, duration: true, errors: true, security: true,
});

export interface SessionFilters {
  source?: string;
  project?: string;
  model?: string;
  q?: string;
  from?: string;
  to?: string;
  kind?: "main" | "subagent";
  /** Keep only sessions that have ≥1 finding of one of these severities. */
  severity?: string[];
  /** Keep only sessions that have ≥1 errored tool call of one of these error types. */
  errorType?: string[];
  /** Column to sort the whole filtered list by (before pagination). Defaults to "started". */
  sort?: SessionSort;
  dir?: SortDir;
  limit: number;
  offset: number;
}

/**
 * Turn a user's search box input into a safe FTS5 MATCH expression. The raw string is otherwise
 * parsed as FTS5 *query syntax*, so a hyphen, colon (column filter), or bareword operator throws
 * (e.g. "swe-workflow" → `SQLITE_ERROR: no such column: workflow`). We treat the input as literal
 * terms: split on whitespace and wrap each token in double quotes (doubling embedded quotes per
 * FTS5 escaping), joined by space (implicit AND). Phrasing also lets the tokenizer split intra-token
 * punctuation, so "swe-workflow" matches the adjacent tokens "swe workflow". Returns "" for input
 * with no usable tokens (caller guards on a non-empty trimmed query). */
function toFtsQuery(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
}

/** Total tokens for one session (all four classes), matching `tokensOf(splitOf(…))`. */
const TOKENS_SORT_SQL = `(SELECT COALESCE(SUM(t.input_tokens + t.output_tokens
      + t.cache_creation_input_tokens + t.cache_read_input_tokens), 0)
    FROM token_usage t WHERE t.session_id = s.id)`;

/** Security ordering: worst severity first, finding count as the tiebreak. */
const SECURITY_SORT_SQL = `(${severityRankSql("worst_severity")}) * 1000000 + finding_count`;

/**
 * Cost for one session, in SQL — a transcription of `costForUsage` (rate per 1M tokens, per class)
 * that lets the session list ORDER BY cost without costing every matching session in JS first.
 *
 * The rates it joins come from {@link ratesCte}, never from a literal table: pricing is
 * config-overridable (ADR-028), so the active table is the only correct source. The join reproduces
 * `rateForModel`'s **longest-prefix** match — an equality join would price a dated id like
 * `claude-haiku-4-5-20251001` at zero, which is precisely the silent-$0 failure ADR-028 was cut to
 * fix. `substr` rather than `LIKE` because `_` is a LIKE wildcard and model ids may contain one.
 *
 * This duplicates the cost formula (the other copy is `costForUsage`); `pricing-sql.test.ts` asserts
 * the two agree, including under an override.
 */
const COST_SORT_SQL = `(SELECT COALESCE(SUM((tu.input_tokens * mr.i_rate + tu.output_tokens * mr.o_rate
      + tu.cache_creation_input_tokens * mr.cw_rate + tu.cache_read_input_tokens * mr.cr_rate) / 1000000.0), 0)
    FROM token_usage tu LEFT JOIN model_rate mr ON mr.model IS tu.model
    WHERE tu.session_id = s.id)`;

/**
 * A `WITH rates(…)` clause carrying the *active* price table (built-in defaults merged with any
 * config overrides) as bound parameters. Built per query, never cached at module scope — `usePricing`
 * can swap the table at startup and tests install their own.
 */
function ratesCte(): { sql: string; params: unknown[] } {
  const entries = Object.entries(activePricing());
  return {
    // `model_rate` resolves the prefix match ONCE per distinct model id, not once per token_usage row.
    // Inlining the lookup into the cost expression instead re-ran it for every usage row of every
    // candidate session — ~35× slower on a real corpus, which would have made this "fix" a regression.
    sql: `WITH rates(prefix, i_rate, o_rate, cw_rate, cr_rate) AS (VALUES ${entries.map(() => "(?,?,?,?,?)").join(",")}),
      model_rate AS (
        SELECT m.model, r.i_rate, r.o_rate, r.cw_rate, r.cr_rate
        FROM (SELECT DISTINCT model FROM token_usage) m
        LEFT JOIN rates r ON r.prefix = (
          SELECT p.prefix FROM rates p WHERE substr(m.model, 1, length(p.prefix)) = p.prefix
          ORDER BY length(p.prefix) DESC LIMIT 1)) `,
    params: entries.flatMap(([prefix, r]) => [prefix, r.input, r.output, r.cacheWrite, r.cacheRead]),
  };
}

/** The WHERE clause (over `sessions s`) and its bound params for the session list's filters. */
function sessionListWhere(f: SessionFilters): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.source) (where.push("s.source_id = ?"), params.push(f.source));
  if (f.project) (where.push("s.project_id = ?"), params.push(f.project));
  // Date-inclusive on both ends (see findingWhere): a picked `to` day must include that day's sessions.
  pushDateRange(where, params, "s.started_at", f.from, f.to);
  if (f.kind === "main") where.push("s.is_sidechain = 0");
  if (f.kind === "subagent") where.push("s.is_sidechain = 1");
  // Multi-select: session has ≥1 finding of any listed severity / ≥1 errored tool call of any listed type.
  if (f.severity?.length) {
    where.push(`EXISTS (SELECT 1 FROM findings fd WHERE fd.session_id = s.id AND fd.severity IN (${placeholders(f.severity)}))`);
    params.push(...f.severity);
  }
  if (f.errorType?.length) {
    where.push(`EXISTS (SELECT 1 FROM tool_calls tc WHERE tc.session_id = s.id AND tc.error_type IN (${placeholders(f.errorType)}))`);
    params.push(...f.errorType);
  }
  if (f.model) {
    // Family match, not exact (ADR-037): canonical on both sides, so picking a model admits every
    // dated snapshot of it — and a saved link carrying a raw dated id still resolves.
    where.push(`EXISTS (SELECT 1 FROM token_usage t WHERE t.session_id = s.id AND ${canonModelSql("t.model")} = ?)`);
    params.push(canonicalModel(f.model));
  }
  if (f.q && f.q.trim()) {
    // Match transcript text (FTS) OR the session's own name (slug/ai_title) OR its project path, so a
    // query like "fix-youtube-embed-csp-policy" finds the session by slug even when that string never
    // appears verbatim in an event. A project-path *subquery* (not a join on p.path) keeps
    // listSessions' un-joined COUNT(*) query valid. SQLite LIKE is case-insensitive for ASCII.
    const like = `%${f.q.trim()}%`;
    where.push(
      `(s.id IN (SELECT DISTINCT e.session_id FROM events e JOIN events_fts f ON f.rowid = e.rowid WHERE events_fts MATCH ?)
        OR s.slug LIKE ? OR s.ai_title LIKE ?
        OR s.project_id IN (SELECT id FROM projects WHERE path LIKE ?))`,
    );
    params.push(toFtsQuery(f.q), like, like, like);
  }
  return { sql: whereClause(where), params };
}

export function listSessions(db: DB, f: SessionFilters): SessionsPage {
  const { sql: whereSql, params } = sessionListWhere(f);

  const total = queryGet<CountRow>(db, `SELECT COUNT(*) n FROM sessions s ${whereSql}`, ...params)!.n;

  const baseSelect = `SELECT s.id, s.ai_title, s.slug, s.source_id, s.is_sidechain, s.started_at,
              s.duration_ms, s.event_count, s.turn_count, p.path AS project_path,
              ${SESSION_MODELS_SQL},
              (SELECT COUNT(*) FROM tool_calls tc WHERE tc.session_id = s.id) AS tool_call_count,
              (SELECT COUNT(*) FROM tool_calls tc WHERE tc.session_id = s.id AND tc.status = 'error') AS tool_error_count,
              (SELECT COUNT(*) FROM findings fd WHERE fd.session_id = s.id) AS finding_count,
              (SELECT fd.severity FROM findings fd WHERE fd.session_id = s.id
                 ORDER BY ${severityRankSql("fd.severity")} DESC
                 LIMIT 1) AS worst_severity
       FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
       ${whereSql}`;

  // Every sortable column resolves to a SQL expression, so ORDER BY + LIMIT do the paging. Stored
  // columns are direct; the derived ones (tokens/cost/errors/security) are the subquery or CASE the
  // projection above already computes, referenced by output alias where one exists. These four used
  // to sort in JS over the WHOLE matching set — O(corpus) on every request, per the comment this
  // replaces — which is what made the session list the worst-scaling query in the server.
  const ORDER = {
    started: "s.started_at",
    title: "COALESCE(NULLIF(s.ai_title, ''), s.slug)",
    turns: "s.turn_count",
    duration: "s.duration_ms",
    errors: "tool_error_count",
    tokens: TOKENS_SORT_SQL,
    cost: COST_SORT_SQL,
    security: SECURITY_SORT_SQL,
  };
  const sortKey = f.sort ?? "started";

  // The cost expression joins a rates CTE, so that clause has to lead the statement — and its bound
  // parameters therefore come before the WHERE's. Only built when actually sorting by cost.
  const rates = sortKey === "cost" ? ratesCte() : null;
  const sessions = attachSessionCost(
    db,
    queryAll<SessionListRow>(
      db,
      `${rates?.sql ?? ""}${baseSelect} ORDER BY ${orderBy(ORDER, sortKey, "started", f.dir)}, s.id ASC LIMIT ? OFFSET ?`,
      ...(rates?.params ?? []),
      ...params,
      f.limit,
      f.offset,
    ),
  );

  return { total, sessions };
}

/** Add per-session `tokens`, `token_split`, `cost` (USD, cache-aware) and `title` to each list row,
 * turning the projection into the response shape. Costs are grouped by model so per-model rates apply. */
function attachSessionCost(db: DB, rows: SessionListRow[]): SessionSummary[] {
  const usage = usageBySession(db, rows.map((r) => r.id));
  return rows.map(({ ai_title, slug, ...r }) => {
    const u = usage.get(r.id) ?? [];
    const split = splitOf(u);
    return {
      ...r,
      tokens: tokensOf(split),
      token_split: split,
      cost: costOf(u),
      unpriced_models: unpricedOf(u),
      title: displayTitle(ai_title, slug),
    };
  });
}
