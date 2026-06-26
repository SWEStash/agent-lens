import Database from "better-sqlite3";
import { SCHEMA_SQL, SCHEMA_VERSION } from "@agent-lens/core";

export type DB = Database.Database;

/** Open (creating if needed) the Agent Lens database and ensure the schema is applied. */
export function openDb(file: string): DB {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  db.prepare(
    "INSERT INTO meta(key, value) VALUES ('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(SCHEMA_VERSION));
  return db;
}
