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
  it("opens every ingest connection with the WAL size limit applied", () => {
    const db = openRaw(dbPath);
    try {
      expect(db.prepare("PRAGMA journal_size_limit").get()).toEqual({ journal_size_limit: WAL_SIZE_LIMIT });
    } finally {
      db.close();
    }
  });

  // The mechanism, at 1/64 of the real limit: writing 1.5x the cap took ~96 MB of WAL and timed out on
  // slower CI runners. The limit is the same pragma openRaw sets, so a smaller value proves the same path.
  it("truncates an oversized WAL on the next write while a reader keeps the DB open", () => {
    const limit = WAL_SIZE_LIMIT / 64;
    const db = openRaw(dbPath);
    let reader: DatabaseSync | undefined;
    try {
      db.exec(`PRAGMA journal_size_limit = ${limit}`);
      db.exec("CREATE TABLE t (b BLOB)");
      reader = new DatabaseSync(dbPath, { readOnly: true });
      reader.prepare("SELECT count(*) FROM t").get();

      // One transaction cannot be checkpointed mid-way, so the WAL must grow past the cap to hold it.
      db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${(1.5 * limit) / 4096})
               INSERT INTO t SELECT randomblob(4096) FROM n`);
      expect(walBytes()).toBeGreaterThan(limit);

      db.exec("PRAGMA wal_checkpoint(PASSIVE)");
      db.exec("INSERT INTO t VALUES (x'00')");
      expect(walBytes()).toBeLessThanOrEqual(limit);
    } finally {
      reader?.close();
      db.close();
    }
  });
});
