/**
 * WAL size cap (db.ts WAL_SIZE_LIMIT). SQLite never shrinks a WAL on its own, and the server's open
 * read connection stops the file from being deleted when ingest closes, so before the cap one
 * `--full` rebuild left ~1.5 GB of WAL on disk indefinitely. This reproduces that shape: a reader held
 * open, one write far larger than the cap, then an ordinary write, which must truncate the file back.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { openRaw, WAL_SIZE_LIMIT } from "../dist/db.js";

let root: string;
let dbPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "al-wal."));
  dbPath = join(root, "test.db");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const walBytes = () => statSync(`${dbPath}-wal`).size;

describe("WAL size cap", () => {
  it("truncates an oversized WAL on the next write while a reader keeps the DB open", () => {
    const db = openRaw(dbPath);
    db.exec("CREATE TABLE t (b BLOB)");
    const reader = new DatabaseSync(dbPath, { readOnly: true });
    reader.prepare("SELECT count(*) FROM t").get();

    // One transaction cannot be checkpointed mid-way, so the WAL must grow past the cap to hold it.
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${(1.5 * WAL_SIZE_LIMIT) / 4096})
             INSERT INTO t SELECT randomblob(4096) FROM n`);
    expect(walBytes()).toBeGreaterThan(WAL_SIZE_LIMIT);

    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    db.exec("INSERT INTO t VALUES (x'00')");
    expect(walBytes()).toBeLessThanOrEqual(WAL_SIZE_LIMIT);

    reader.close();
    db.close();
  });
});
