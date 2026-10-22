/** Connection setup, schema status, and the small helpers every query area shares. */
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION, SEVERITY_ORDER } from "@agent-lens/core";
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
