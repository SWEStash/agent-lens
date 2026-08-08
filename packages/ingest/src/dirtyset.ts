/**
 * Agent Lens — incremental "dirty set" temp table.
 *
 * The derived passes (classify / detect / errors / prune / linkage) each scope their work to the
 * sessions touched this run by materializing the id set into a TEMP table and joining against it
 * (ADR-010). The DROP → CREATE TEMP → batched INSERT prologue lives here once, rather than at each
 * of the 5 call sites. `name` is an internal constant table name (`_dirty`, `_dirty_sec`, …), never
 * user input — safe to interpolate. Callers drop the table themselves when the pass is done.
 */
import { transaction } from "@agent-lens/core";
import type { DB } from "./db.js";

/** (Re)create a single-column TEMP id table `name` and populate it from `ids`, in one transaction. */
export function createDirtySet(db: DB, name: string, ids: Iterable<string>): void {
  db.exec(`DROP TABLE IF EXISTS ${name}`);
  db.exec(`CREATE TEMP TABLE ${name} (id TEXT PRIMARY KEY)`);
  const ins = db.prepare(`INSERT OR IGNORE INTO ${name} (id) VALUES (?)`);
  transaction(db, (xs: Iterable<string>) => {
    for (const id of xs) ins.run(id);
  })(ids);
}
