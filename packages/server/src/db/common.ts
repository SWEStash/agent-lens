/** Connection setup, schema status, and the small helpers every query area shares. */
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION, SEVERITY_ORDER } from "@agent-lens/core";
import type { PermissionDecision, PermissionVia } from "@agent-lens/contracts";
import { canonModelSql, queryGet } from "../sql-util.js";

export type DB = DatabaseSync;

/** A session's display title: its AI title, else its slug. `||`, not `??` — an empty ai_title falls
 *  through too, matching the SQL sort key `COALESCE(NULLIF(s.ai_title, ''), s.slug)`. */
export const displayTitle = (aiTitle: string | null, slug: string | null): string | null => aiTitle || slug || null;

/** The `models` column of a session row: the distinct canonical model ids it spent tokens under. */
export const SESSION_MODELS_SQL = `(SELECT GROUP_CONCAT(DISTINCT ${canonModelSql("model")}) FROM token_usage t WHERE t.session_id = s.id) AS models`;

/** Page cache for the read connection, in KiB. */
const READ_CACHE_KIB = 64 * 1024;

export function openReadonly(file: string): DB {
  // `readOnly` also supplies the old `fileMustExist`: node:sqlite refuses to create a DB it may not
  // write. `query_only` is belt-and-braces on top — it also blocks writes through an ATTACHed handle.
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec("PRAGMA query_only = ON");
  // 64 MB of page cache instead of SQLite's 2 MB: the five dashboard aggregates run ~20% faster on
  // the real store (1.6 s → 1.3 s) for ~75 MB of RSS. 256 MB gained only ~8% more.
  db.exec(`PRAGMA cache_size = -${READ_CACHE_KIB}`);
  return db;
}

/**
 * Compare the DB's stamped schema version against the version this server build expects. `stale` means
 * the on-disk DB was written by an older schema (a bump requires `agent-lens ingest --full` to rebuild)
 * — the UI surfaces this so a mismatch doesn't silently show missing/empty columns. `db_version` is null
 * on an unstamped/never-ingested DB (treated as not-stale: nothing to warn about yet).
 */
export function schemaStatus(db: DB): { db_version: number | null; expected: number; stale: boolean } {
  const row = queryGet<{ value: string }>(db, "SELECT value FROM meta WHERE key = 'schema_version'");
  const dbVersion = row ? Number(row.value) : null;
  const db_version = dbVersion != null && Number.isFinite(dbVersion) ? dbVersion : null;
  return { db_version, expected: SCHEMA_VERSION, stale: db_version != null && db_version !== SCHEMA_VERSION };
}

/**
 * Wall-clock time of the most recent ingest run that wrote anything, as an ISO8601 string (or null on
 * a never-ingested DB). Every archive file touched by a run gets the same `ingested_at` stamp, so the
 * max across `ingest_state` is exactly "data last refreshed at". Powers the header freshness readout.
 */
export function lastIngested(db: DB): string | null {
  return queryGet<{ last: string | null }>(db, "SELECT MAX(ingested_at) AS last FROM ingest_state")!.last;
}

/**
 * `severityRank` (core SEVERITY_ORDER) in SQL, shifted up by one: info=1 … critical=5, and anything
 * else — unknown or absent — 0, so it sorts below info. Generated, so it cannot drift from the order.
 */
export const severityRankSql = (col: string): string =>
  `CASE ${col} ${SEVERITY_ORDER.map((s, i) => `WHEN '${s}' THEN ${i + 1}`).join(" ")} ELSE 0 END`;

/** Parse a stored JSON column back to a value, or null when absent/malformed. */
export function safeJson(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const permissionColumnsCache = new WeakMap<DB, boolean>();

/** Whether `tool_calls` has the permission columns (schema v17, ADR-040). A store from an older build
 *  lacks them until `ingest --full`; the server still serves it, with every call "not recorded". */
export function hasPermissionColumns(db: DB): boolean {
  let has = permissionColumnsCache.get(db);
  if (has === undefined) {
    has = queryGet<{ n: number }>(db, "SELECT COUNT(*) n FROM pragma_table_info('tool_calls') WHERE name = 'permission_decision'")!.n > 0;
    permissionColumnsCache.set(db, has);
  }
  return has;
}

/** The permission columns of `tool_calls` (ADR-040), selected flat under `perm_*` aliases; NULLs on a
 *  store that predates them. */
export const permissionCols = (db: DB, alias: string): string =>
  hasPermissionColumns(db)
    ? `${alias}.permission_decision AS perm_decision, ${alias}.permission_via AS perm_via, ${alias}.permission_scope AS perm_scope,
       ${alias}.permission_rule_source AS perm_rule_source, ${alias}.permission_reason AS perm_reason`
    : "NULL AS perm_decision, NULL AS perm_via, NULL AS perm_scope, NULL AS perm_rule_source, NULL AS perm_reason";

/** What `permissionCols` adds to a row. */
export interface PermissionColumns {
  perm_decision: string | null;
  perm_via: string | null;
  perm_scope: string | null;
  perm_rule_source: string | null;
  perm_reason: string | null;
}

/** Fold the flat `perm_*` columns into the response's `permission` object, and strip them. NULL
 *  decision = not recorded = null (ADR-040). */
export function withPermission<T extends PermissionColumns>(row: T): Omit<T, keyof PermissionColumns> & { permission: PermissionDecision | null } {
  const { perm_decision, perm_via, perm_scope, perm_rule_source, perm_reason, ...rest } = row;
  const permission: PermissionDecision | null =
    perm_decision === "accept" || perm_decision === "reject"
      ? { decision: perm_decision, via: (perm_via ?? "other") as PermissionVia, scope: perm_scope, rule_source: perm_rule_source, reason: perm_reason }
      : null;
  return { ...rest, permission };
}
