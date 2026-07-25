/** Shared read-only SQL helpers for the server. */
import type { DB } from "./db.js";

/** Whether a table exists — the server opens the DB read-only, so a not-yet-ingested schema (e.g. no
 * workflow_results table) must degrade gracefully rather than throw. */
export function tableExists(db: DB, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

/**
 * Typed `prepare(sql).all(...params)`. The caller names the row shape `T` once (a `@agent-lens/contracts`
 * row, a server-local derived shape from `rows.ts`, or an inline shape) and the cast lives here instead
 * of at every call site — so a column the query doesn't actually select is a compile error, not a silent
 * `undefined` at runtime. better-sqlite3 has no static knowledge of a query's columns, so the single
 * `as T[]` here is the unavoidable boundary; keep it the only one.
 */
export function queryAll<T>(db: DB, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

/** Typed `prepare(sql).get(...params)` — returns the row or `undefined`. See {@link queryAll}. */
export function queryGet<T>(db: DB, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
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
