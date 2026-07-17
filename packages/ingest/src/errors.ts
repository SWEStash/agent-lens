/**
 * Agent Lens — tool-error classification pass. Stamps `tool_calls.error_type` for every errored tool
 * call (`status='error'`) by running the deterministic core classifier (classifyToolError) over its
 * verbatim `result_summary`. Re-runnable and idempotent — like classify()/detect(), it re-derives from
 * signals already in the DB and yields identical rows every run.
 *
 * Why a stored column (not read-time): the sessions list filters by error type in SQL, and the
 * dashboard/detail aggregate on it — a column keeps one source of truth (the core classifier) while
 * letting SQL do the filtering/grouping. The raw `status='error'` count stays the authoritative signal;
 * `error_type` is the heuristic bucket (see packages/core/src/errors.ts for the authority boundary).
 */
import { classifyToolError, ERROR_CLASSIFIER_VERSION } from "@agent-lens/core";
import type { DB } from "./db.js";

/**
 * (Re)classify errored tool calls into `error_type`. `dirty` (the expanded id set rebuildDerived
 * returns) scopes an incremental run to the touched sessions; null/undefined → reclassify everything.
 * Returns the number of rows stamped + the engine version.
 */
export function classifyErrors(db: DB, dirty?: Set<string> | null): { count: number; version: number } {
  const incremental = dirty != null;
  const scope = incremental ? " AND session_id IN (SELECT id FROM _dirty_err)" : "";

  if (incremental) {
    db.exec("DROP TABLE IF EXISTS _dirty_err");
    db.exec("CREATE TEMP TABLE _dirty_err (id TEXT PRIMARY KEY)");
    const ins = db.prepare("INSERT OR IGNORE INTO _dirty_err (id) VALUES (?)");
    db.transaction((ids: Iterable<string>) => {
      for (const id of ids) ins.run(id);
    })(dirty);
  }

  const rows = db
    .prepare(`SELECT id, result_summary FROM tool_calls WHERE status = 'error'${scope}`)
    .all() as Array<{ id: string; result_summary: string | null }>;

  const update = db.prepare("UPDATE tool_calls SET error_type = ? WHERE id = ?");
  const tx = db.transaction(() => {
    // Reset the scoped rows' error_type first so a row that stops being an error (or changes bucket) on
    // re-derive doesn't keep a stale label. Non-error rows always have NULL.
    db.exec(`UPDATE tool_calls SET error_type = NULL WHERE error_type IS NOT NULL${scope}`);
    for (const r of rows) update.run(classifyToolError(r.result_summary).type, r.id);
  });
  tx();

  if (incremental) db.exec("DROP TABLE IF EXISTS _dirty_err");
  const count = (db.prepare("SELECT COUNT(*) n FROM tool_calls WHERE error_type IS NOT NULL").get() as { n: number }).n;
  return { count, version: ERROR_CLASSIFIER_VERSION };
}
