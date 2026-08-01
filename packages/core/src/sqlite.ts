/**
 * SQLite access helpers over Node's built-in `node:sqlite` (ADR-029).
 *
 * `DatabaseSync` covers everything the store needs except `db.transaction(fn)`, which better-sqlite3
 * provided and `node:sqlite` does not. {@link transaction} is that one gap, kept here so `ingest` and
 * `server` share a single implementation of the rollback semantics.
 *
 * One behavioural difference worth knowing when reading rows back: `.all()` / `.get()` return
 * **null-prototype** objects. Spread, `Object.keys`, `JSON.stringify` and vitest's `toEqual` all
 * behave normally, but `row.hasOwnProperty(…)` and `toStrictEqual` do not.
 */
import type { DatabaseSync, StatementResultingChanges, StatementSync } from "node:sqlite";

/** The open-database handle. Aliased so call sites don't each import from `node:sqlite`. */
export type SqliteDB = DatabaseSync;

/**
 * Bind a declared row object to a named-parameter statement.
 *
 * `node:sqlite` types named parameters as `Record<string, SQLInputValue>`, which a declared interface
 * (`TurnRow`, `ToolCallRow`, …) never satisfies — an interface has no index signature even when every
 * field is bindable. The cast lives here rather than at each call site, mirroring the single read-side
 * boundary in the server's `queryAll`.
 */
export function runNamed(stmt: StatementSync, row: object): StatementResultingChanges {
  return stmt.run(row as Record<string, never>);
}

/** Distinguishes nested savepoints from each other; module-scoped so names never collide. */
let savepointSeq = 0;

/**
 * Run `fn` inside a transaction, committing on return and rolling back on throw.
 *
 * Returns a *callable* rather than running immediately, matching the better-sqlite3 shape the call
 * sites were written against (`const tx = transaction(db, fn); tx(args)`) — arguments and the return
 * value pass straight through.
 *
 * Uses `SAVEPOINT` when a transaction is already open, because SQLite rejects a nested `BEGIN`.
 * Nothing nests today, but `createDirtySet` runs immediately before several of these and would
 * otherwise fail at runtime the first time one moved inside another.
 */
export function transaction<A extends unknown[], R>(db: DatabaseSync, fn: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => {
    const savepoint = db.isTransaction ? `agent_lens_sp_${savepointSeq++}` : "";
    db.exec(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN");
    try {
      const result = fn(...args);
      db.exec(savepoint ? `RELEASE ${savepoint}` : "COMMIT");
      return result;
    } catch (err) {
      // The unwind can itself fail (a failed COMMIT may already have closed the transaction), and
      // that secondary error would mask the real one. Drop it and rethrow the original cause.
      try {
        db.exec(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
      } catch {
        /* ignore — `err` below is the useful failure */
      }
      throw err;
    }
  };
}
