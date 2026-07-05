import Database from "better-sqlite3";
import { SCHEMA_SQL, SCHEMA_VERSION } from "@agent-lens/core";

export type DB = Database.Database;

/** Open (creating if needed) the DB and set pragmas, WITHOUT applying the schema. */
export function openRaw(file: string): DB {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/** The schema version stamped in an existing DB, or null if unstamped/brand-new. */
export function readSchemaVersion(db: DB): number | null {
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  if (!row) return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Apply the current schema (idempotent CREATE IF NOT EXISTS) and stamp the version ONLY when absent.
 * Stamping if-absent (not overwrite) is deliberate: an incremental `ingest` runs CREATE IF NOT EXISTS,
 * which adds new *tables* but cannot migrate altered columns on existing ones — so overwriting the stamp
 * would let a stale DB claim the current version and lie. A stale DB keeps its old stamp; the caller
 * (`runIngest`) guards on it. `resetSchema` drops `meta`, so its applySchema re-stamps the current
 * version from scratch — the only path that advances the stamp.
 */
function applySchema(db: DB): void {
  db.exec(SCHEMA_SQL);
  db.prepare(
    "INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO NOTHING",
  ).run(String(SCHEMA_VERSION));
}

/**
 * Open (creating if needed) the Agent Lens database and ensure the schema is applied.
 * NOTE: on a stale on-disk schema this only adds missing objects (CREATE IF NOT EXISTS) — it does
 * not migrate changed/added columns. A SCHEMA_VERSION bump is applied via `ingest --full`
 * (openRaw + resetSchema), the canonical rebuild path.
 */
export function openDb(file: string): DB {
  const db = openRaw(file);
  applySchema(db);
  return db;
}

/**
 * Drop and recreate every table from the current SCHEMA_SQL. Used by `ingest --full`: because the
 * archive is the source of truth and the DB is a derived projection, a full rebuild is also the
 * migration path — dropping the tables (vs. DELETE FROM) lets a SCHEMA_VERSION bump's new columns
 * take effect on an existing DB without a separate migration mechanism (ADR-001/009).
 */
export function resetSchema(db: DB): void {
  // Disable FK enforcement during teardown: the v3 schema has cross/self references
  // (sessions.parent_turn_id → turns, parent_session_id → sessions) that otherwise make DROP order
  // matter and trip "FOREIGN KEY constraint failed". applySchema re-enables FKs (PRAGMA in SCHEMA_SQL).
  db.pragma("foreign_keys = OFF");
  db.exec(`
    DROP TRIGGER IF EXISTS events_au;
    DROP TRIGGER IF EXISTS events_ad;
    DROP TRIGGER IF EXISTS events_ai;
    DROP TABLE IF EXISTS events_fts;
    DROP TABLE IF EXISTS classifications;
    DROP TABLE IF EXISTS token_usage;
    DROP TABLE IF EXISTS tool_calls;
    DROP TABLE IF EXISTS skills;
    DROP TABLE IF EXISTS events;
    DROP TABLE IF EXISTS turns;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS projects;
    DROP TABLE IF EXISTS sources;
    DROP TABLE IF EXISTS agents;
    DROP TABLE IF EXISTS workflow_results;
    DROP TABLE IF EXISTS session_meta;
    DROP TABLE IF EXISTS tool_results;
    DROP TABLE IF EXISTS ingest_state;
    DROP TABLE IF EXISTS meta;
  `);
  applySchema(db);
  db.pragma("foreign_keys = ON");
}
