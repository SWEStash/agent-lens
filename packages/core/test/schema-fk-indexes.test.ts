/**
 * Every foreign-key column must lead some index. Deleting a parent row makes SQLite look up the
 * child rows that reference it, and without an index on the child column each deleted parent costs
 * a full scan of the child table. tool_calls.turn_id and token_usage.turn_id had none, so the
 * incremental rebuild's turn delete read 12.9 GB to re-ingest five files on the real store.
 *
 * EXEMPT lists child columns whose parent table is never deleted from while foreign_keys is ON, so
 * no lookup ever runs. The exclude prune deletes events and tool_calls with it OFF (pipeline.ts).
 * An index there would only slow writes. Start deleting one of those parents and its entry must go.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "../dist/schema.js";

const EXEMPT = new Set([
  "sources.agent_id -> agents",
  "sessions.agent_id -> agents",
  "tool_calls.event_uuid -> events",
  "file_changes.tool_call_id -> tool_calls",
]);

describe("schema foreign keys", () => {
  it("every foreign-key column is the leading column of an index on its table", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA_SQL);
    const q = <T>(sql: string, ...p: string[]) => db.prepare(sql).all(...p) as T[];

    const unindexed: string[] = [];
    for (const { name } of q<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%'")) {
      const leading = new Set<string>();
      for (const ix of q<{ name: string }>("SELECT name FROM pragma_index_list(?)", name)) {
        const first = q<{ name: string }>("SELECT name FROM pragma_index_info(?) WHERE seqno = 0", ix.name)[0];
        if (first) leading.add(first.name);
      }
      for (const fk of q<{ from: string; table: string }>('SELECT "from", "table" FROM pragma_foreign_key_list(?)', name)) {
        const edge = `${name}.${fk.from} -> ${fk.table}`;
        if (!leading.has(fk.from) && !EXEMPT.has(edge)) unindexed.push(edge);
      }
    }
    expect(unindexed).toEqual([]);
  });
});
