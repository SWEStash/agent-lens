/** Shared read-only SQL helpers for the server. */
import type { DB } from "./db.js";

/** Whether a table exists — the server opens the DB read-only, so a not-yet-ingested schema (e.g. no
 * workflow_results table) must degrade gracefully rather than throw. */
export function tableExists(db: DB, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}
