/**
 * Schema-version guard (db.ts) — proves the stamp is honest across an incremental ingest:
 *   - applySchema (via openDb) stamps the version only when ABSENT, so a DB stamped by an older build
 *     keeps its stale stamp (it must NOT silently claim the current version after CREATE IF NOT EXISTS).
 *   - resetSchema (the `--full` rebuild) drops meta and re-stamps the current version — the only advance.
 *   - readSchemaVersion reads it back. Imports the BUILT dist (matches the other suites).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL, SCHEMA_VERSION } from "@agent-lens/core";
import { openDb, openRaw, resetSchema, readSchemaVersion, SchemaMismatchError } from "../dist/db.js";

let root: string;
let dbPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "al-sg."));
  dbPath = join(root, "test.db");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("schema-version guard", () => {
  it("refuses a store stamped by an older build, and leaves its stamp alone", () => {
    // Simulate a DB last written by an older build: minimal meta table stamped one version back.
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    seed.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION - 1));
    seed.close();

    expect(() => openDb(dbPath)).toThrow(SchemaMismatchError);
    const raw = openRaw(dbPath);
    expect(readSchemaVersion(raw)).toBe(SCHEMA_VERSION - 1);
    raw.close();
  });

  it("refuses an older store BEFORE applying the new schema, so the user gets the rebuild hint, not a SQL error", () => {
    // A realistic older store: today's tables minus a column the current schema indexes. Applying
    // SCHEMA_SQL first would fail on that index ("no such column"), which is how the v16 upgrade
    // first surfaced: the timer died in openDb before the version check could say "run --full".
    const seed = new DatabaseSync(dbPath);
    seed.exec(SCHEMA_SQL);
    seed.exec("DROP INDEX idx_sessions_continued_from");
    seed.exec("ALTER TABLE sessions DROP COLUMN continued_from_session_id");
    seed.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION - 1));
    seed.close();

    expect(() => openDb(dbPath)).toThrow(/DB is v\d+, this build expects v\d+.*ingest --full/);
  });

  it("stamps the current version on a fresh DB", () => {
    const db = openDb(dbPath);
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("resetSchema advances a stale stamp to the current version", () => {
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    seed.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION - 1));
    seed.close();

    const db = openRaw(dbPath);
    resetSchema(db);
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("readSchemaVersion is null on an unstamped DB", () => {
    const db = openRaw(dbPath);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    expect(readSchemaVersion(db)).toBeNull();
    db.close();
  });
});
