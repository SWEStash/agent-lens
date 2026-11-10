/**
 * Foreign-key violations, described well enough to act on. Ingest checks before every commit
 * (ADR-038): SQLite's own report is a bare `FOREIGN KEY constraint failed` at COMMIT, with no table,
 * key or session, and the run rolls back without saying what it refused to write.
 */
import type { DB } from "./db.js";

export interface ForeignKeyViolation {
  table: string;
  column: string;
  parent: string;
  rows: number;
  /** Up to SAMPLE distinct referenced keys that have no parent row. */
  missing: string[];
  /** Up to SAMPLE archive files whose lines produced the offending rows, when they can be traced. */
  files: string[];
}

const SAMPLE = 5;

/** Every violation in the store, one entry per (table, column, parent) edge. Empty when consistent. */
export function foreignKeyViolations(db: DB): ForeignKeyViolation[] {
  const bad = db.prepare("PRAGMA foreign_key_check").all() as Array<{ table: string; rowid: number; parent: string; fkid: number }>;
  const edges = new Map<string, { table: string; parent: string; fkid: number; rowids: number[] }>();
  for (const b of bad) {
    const key = `${b.table}\0${b.fkid}`;
    const e = edges.get(key) ?? { table: b.table, parent: b.parent, fkid: b.fkid, rowids: [] };
    e.rowids.push(b.rowid);
    edges.set(key, e);
  }
  return [...edges.values()].map((e) => describeEdge(db, e));
}

function describeEdge(db: DB, e: { table: string; parent: string; fkid: number; rowids: number[] }): ForeignKeyViolation {
  const fk = (db.prepare(`PRAGMA foreign_key_list(${e.table})`).all() as Array<{ id: number; from: string }>).find((f) => f.id === e.fkid);
  const column = fk?.from ?? "?";
  const cols = new Set((db.prepare(`PRAGMA table_info(${e.table})`).all() as Array<{ name: string }>).map((c) => c.name));
  // Look the rows up through a temp table: the rowid list can be long.
  db.exec("CREATE TEMP TABLE IF NOT EXISTS _fk_rows (rowid_ INTEGER PRIMARY KEY)");
  db.exec("DELETE FROM _fk_rows");
  const ins = db.prepare("INSERT OR IGNORE INTO _fk_rows VALUES (?)");
  for (const r of e.rowids) ins.run(r);
  const rows = `SELECT * FROM ${e.table} WHERE rowid IN (SELECT rowid_ FROM _fk_rows)`;

  const missing = column === "?" ? [] : pluck(db, `SELECT DISTINCT ${column} v FROM (${rows}) ORDER BY v LIMIT ${SAMPLE}`);
  // A row traces to its archive file through its own event, or through any event of its session.
  const via = [
    cols.has("event_uuid") ? `uuid IN (SELECT event_uuid FROM (${rows}))` : null,
    cols.has("session_id") ? `session_id IN (SELECT session_id FROM (${rows}))` : null,
  ].filter(Boolean);
  const files = via.length
    ? pluck(db, `SELECT DISTINCT source_file v FROM events WHERE source_file IS NOT NULL AND (${via.join(" OR ")}) ORDER BY v LIMIT ${SAMPLE}`)
    : [];
  db.exec("DROP TABLE _fk_rows");
  return { table: e.table, column, parent: e.parent, rows: e.rowids.length, missing, files };
}

const pluck = (db: DB, sql: string) => (db.prepare(sql).all() as Array<{ v: unknown }>).map((r) => String(r.v));

/** Throw, naming every violated edge, its missing keys and source files, if the store has any. */
export function assertForeignKeys(db: DB): void {
  const found = foreignKeyViolations(db);
  if (!found.length) return;
  const lines = found.map((v) => {
    const more = (shown: string[], label: string) => (shown.length ? `\n    ${label}: ${shown.join(", ")}` : "");
    return `  ${v.table}.${v.column} -> ${v.parent}: ${v.rows} rows${more(v.missing, "missing")}${more(v.files, "from")}`;
  });
  throw new Error(
    `agent-lens-ingest: the run would leave rows pointing at missing parents, so it was rolled back and nothing was written.\n` +
      `${lines.join("\n")}\n` +
      `This is an ingest bug, not a problem with your data: please report it with the lines above.`,
  );
}
