/** Shared read-only SQL helpers for the server. */
import type { SQLInputValue } from "node:sqlite";
import type { DB } from "./db.js";

/** Bound parameters, as `node:sqlite` wants them. Call sites pass `unknown` and cast through here. */
const bind = (params: unknown[]): SQLInputValue[] => params as SQLInputValue[];

/** Whether a table exists — the server opens the DB read-only, so a not-yet-ingested schema (e.g. no
 * workflow_results table) must degrade gracefully rather than throw. */
export function tableExists(db: DB, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

/**
 * Typed `prepare(sql).all(...params)`. The caller names the row shape `T` once (a `@agent-lens/contracts`
 * row, a server-local derived shape from `rows.ts`, or an inline shape) and the cast lives here instead
 * of at every call site — so a column the query doesn't actually select is a compile error, not a silent
 * `undefined` at runtime. SQLite has no static knowledge of a query's columns, so the single cast
 * here is the unavoidable boundary; keep it the only one.
 */
export function queryAll<T>(db: DB, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...bind(params)) as unknown as T[];
}

/** Typed `prepare(sql).get(...params)` — returns the row or `undefined`. See {@link queryAll}. */
export function queryGet<T>(db: DB, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...bind(params)) as T | undefined;
}

/**
 * Append an inclusive `from`/`to` date-range filter on `col` to a WHERE-clause accumulator. Both ends
 * compare the DATE part (`date(col) >= date(?)`) so a picked `to` day includes that whole day — a plain
 * `col <= '2026-07-14'` would drop everything after midnight. `col` is an internal column expression
 * (e.g. `s.started_at`), never user input. Mutates `clauses`/`params` in place.
 */
export function pushDateRange(clauses: string[], params: unknown[], col: string, from?: string, to?: string): void {
  if (from) {
    clauses.push(`date(${col}) >= date(?)`);
    params.push(from);
  }
  if (to) {
    clauses.push(`date(${col}) <= date(?)`);
    params.push(to);
  }
}

/** The subagent-meta LEFT JOIN, present only when the `session_meta` table exists (pre-ingest DBs). */
export function metaJoin(hasMeta: boolean): string {
  return hasMeta ? "LEFT JOIN session_meta sm ON sm.session_id = s.id" : "";
}

/** The subagent-meta column projection — real columns when `session_meta` exists, else NULL stand-ins
 *  so the row shape is stable regardless of whether the table has been ingested yet. Pairs with
 *  {@link metaJoin}; leads with a comma to append to a SELECT list. */
export function metaProjection(hasMeta: boolean): string {
  return hasMeta
    ? ", sm.agent_type, sm.agent_description, sm.spawn_depth"
    : ", NULL AS agent_type, NULL AS agent_description, NULL AS spawn_depth";
}

/**
 * Resolve a request's `sort`/`dir` into an `ORDER BY` fragment. SQLite can't parameterize an ORDER BY
 * expression, so it has to be interpolated — which makes this the one place a request value could
 * reach the SQL text. It can't: the expression is always a value from the caller's literal `columns`
 * map (an unknown key falls back to `fallback`, which must itself be a key of that map), and the
 * direction collapses to one of two literals. Route the interpolation through here, never build it
 * inline, and the invariant stays next to the string it protects (SLOP-071).
 */
export function orderBy<K extends string>(columns: Record<K, string>, sort: string | undefined, fallback: K, dir?: string): string {
  // Object.hasOwn, not `in` / `map[key] ?? fallback`: both walk the prototype chain, so `?sort=toString`
  // resolves to Function.prototype.toString and its SOURCE TEXT lands in the query (a 500, not an
  // injection — but exactly what this helper exists to prevent).
  const col = sort !== undefined && Object.hasOwn(columns, sort) ? columns[sort as K] : columns[fallback];
  return `${col} ${dir === "asc" ? "ASC" : "DESC"}`;
}

/**
 * Resolve a request's `?limit=` into a row count within `[1, max]`.
 *
 * `Math.min(Number(q.limit) || 50, max)` looks equivalent and is not: it guards only the UPPER bound,
 * so `?limit=-1` yields -1, and SQLite reads a negative LIMIT as "no limit" — the page cap is gone and
 * the whole table comes back in one response. Non-integers are floored for the same reason `offset`
 * needs it (see {@link pageOffset}).
 */
export function pageLimit(raw: unknown, fallback: number, max: number): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return Math.min(fallback, max);
  return Math.min(n, max);
}

/**
 * Resolve a request's `?offset=` into a non-negative integer.
 *
 * `Number(q.offset) || 0` passes a non-integer straight through — `?offset=1.5` is truthy, reaches
 * SQLite, and throws (a 500) because it will not bind a float to an integer parameter.
 */
export function pageOffset(raw: unknown): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Append `value` to the list stored at `key`, creating the list on first use. Group-by-key is the
 * shape half this module's loaders end in (findings by tool call, tool calls by event). */
export function pushGrouped<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
