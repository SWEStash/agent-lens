import { DatabaseSync } from "node:sqlite";
import { BULK_DEFERRED, SCHEMA_SQL, SCHEMA_VERSION } from "@agent-lens/core";

export type DB = DatabaseSync;

/**
 * Cap on the WAL file size kept between writes. SQLite reuses the WAL from its start after a
 * checkpoint but never shrinks it, and the server's open connection keeps the file from being
 * deleted on close, so one `--full` rebuild (~1.7 GB of WAL) left that much on disk for good. With a
 * limit, the next write after a checkpoint truncates it back. An incremental ingest peaks at ~16 MB,
 * so a normal run never pays the shrink-and-regrow.
 */
export const WAL_SIZE_LIMIT = 64 * 1024 * 1024;

/** Open (creating if needed) the DB and set pragmas, WITHOUT applying the schema. */
export function openRaw(file: string): DB {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT}`);
  db.exec("PRAGMA foreign_keys = ON");
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
export function resetSchema(db: DB, { bulk = false } = {}): void {
  // Disable FK enforcement during teardown: the v3 schema has cross/self references
  // (sessions.parent_turn_id → turns, parent_session_id → sessions) that otherwise make DROP order
  // matter and trip "FOREIGN KEY constraint failed". applySchema re-enables FKs (PRAGMA in SCHEMA_SQL).
  // `finally` so a failed drop/apply can't leave the connection unguarded for the rest of the process.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec(`
      DROP TRIGGER IF EXISTS events_au;
      DROP TRIGGER IF EXISTS events_ad;
      DROP TRIGGER IF EXISTS events_ai;
      DROP TABLE IF EXISTS events_fts;
      DROP TABLE IF EXISTS file_changes;
      DROP TABLE IF EXISTS findings;
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
    // `bulk`: the tables are about to be filled from empty, so leave out what finishBulkLoad builds.
    if (bulk) {
      for (const name of BULK_DEFERRED.indexes) db.exec(`DROP INDEX IF EXISTS ${name}`);
      for (const name of BULK_DEFERRED.triggers) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * Build what `resetSchema(db, { bulk: true })` left out: one sorted pass per index instead of a
 * B-tree update per row, and the full-text index rebuilt from `events` in one go. SCHEMA_SQL is all
 * IF NOT EXISTS, so re-running it recreates exactly the dropped objects from their one definition.
 * With the triggers gone nothing touched events_fts during the load, so 'rebuild' leaves it exact.
 */
export function finishBulkLoad(db: DB): void {
  db.exec(SCHEMA_SQL);
  db.exec("INSERT INTO events_fts(events_fts) VALUES('rebuild')");
}
