/**
 * `ingest --full` drops the objects in BULK_DEFERRED by name and recreates them from SCHEMA_SQL once
 * the load is in. A name that no longer matches the schema (an index renamed, a trigger replaced)
 * would make that DROP a silent no-op: the rebuild still works, but slowly again, and nothing fails.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { BULK_DEFERRED, SCHEMA_SQL } from "../dist/schema.js";

describe("BULK_DEFERRED", () => {
  it("names only objects the schema creates", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA_SQL);
    const names = (type: string) =>
      (db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all(type) as Array<{ name: string }>).map((r) => r.name);
    expect(names("index")).toEqual(expect.arrayContaining([...BULK_DEFERRED.indexes]));
    expect(names("trigger")).toEqual(expect.arrayContaining([...BULK_DEFERRED.triggers]));
  });
});
