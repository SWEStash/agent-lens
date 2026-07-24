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
