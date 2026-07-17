/**
 * Agent Lens — UI preferences store. Like security triage (ADR-018), which charts/columns a user
 * shows is user-authored state that is NOT derivable from the archive, so it can't live in the
 * rebuildable read-only analytics DB. It rides the same **writable sidecar** handle (the triage DB):
 * a generic key→JSON table the server treats as opaque. The client keeps localStorage as an optimistic
 * cache and writes through to here; when no writable store is configured the endpoints degrade so the
 * client simply keeps its local value. Single-user local tool → prefs are global (no per-user key).
 */
import type { TriageDB } from "./triage.js";

export const PREFS_SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS ui_prefs (
  key        TEXT PRIMARY KEY,   -- e.g. 'dashboard.charts', 'sessions.columns'
  value      TEXT NOT NULL,      -- JSON blob, opaque to the server
  updated_at TEXT NOT NULL
);
`;

/** Raw stored JSON string for a key, or null if unset. */
export function getPref(db: TriageDB, key: string): string | null {
  const row = db.prepare("SELECT value FROM ui_prefs WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

/** Upsert a key's JSON string (idempotent). */
export function setPref(db: TriageDB, key: string, value: string): void {
  db.prepare(
    `INSERT INTO ui_prefs (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}
