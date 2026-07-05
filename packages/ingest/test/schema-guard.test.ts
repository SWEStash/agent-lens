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
import Database from "better-sqlite3";
import { SCHEMA_VERSION } from "@agent-lens/core";
import { openDb, openRaw, resetSchema, readSchemaVersion } from "../dist/db.js";

let root: string;
let dbPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "al-sg."));
  dbPath = join(root, "test.db");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("schema-version guard", () => {
  it("keeps a stale stamp — an incremental open never overwrites an older version", () => {
    // Simulate a DB last written by an older build: minimal meta table stamped one version back.
    const seed = new Database(dbPath);
    seed.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    seed.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION - 1));
    seed.close();

    // Incremental open applies CREATE IF NOT EXISTS but must NOT re-stamp.
    const db = openDb(dbPath);
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION - 1);
    db.close();
  });

  it("stamps the current version on a fresh DB", () => {
    const db = openDb(dbPath);
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("resetSchema advances a stale stamp to the current version", () => {
    const seed = new Database(dbPath);
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
