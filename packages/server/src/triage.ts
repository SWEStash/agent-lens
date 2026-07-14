/**
 * Agent Lens — security-finding triage store (ADR-018). User-authored triage state (which findings are
 * dismissed as safe, which rules are muted) is NOT derivable from the archive, so it can't live in the
 * rebuildable analytics DB — `detect()` wipes and re-inserts `findings` on every ingest, and
 * `ingest --full` drops every analytics table. Instead it lives in a **separate, writable `triage.db`**
 * that ingest never touches, keyed by the *stable* finding id (`sha1(tool_call_id, rule_id)`), so triage
 * survives re-detection and full rebuilds automatically.
 *
 * The analytics server handle stays read-only (ADR-005): it only ATTACHes this file to JOIN triage
 * state into the findings list. Writes go through this dedicated handle, guarded by the same CSRF check
 * as `POST /api/refresh`. WAL lets the writer run alongside the read handle's queries.
 */
import Database from "better-sqlite3";

export type TriageDB = Database.Database;

export const TRIAGE_SCHEMA_SQL = /* sql */ `
PRAGMA journal_mode = WAL;

-- Findings the user reviewed and marked safe. Keyed by the stable finding id so it survives re-ingest.
CREATE TABLE IF NOT EXISTS dismissed_findings (
  finding_id   TEXT PRIMARY KEY,   -- findings.id = sha1(tool_call_id, rule_id)
  tool_call_id TEXT,               -- reference only (may be null)
  rule_id      TEXT,               -- reference only (may be null)
  note         TEXT,
  dismissed_at TEXT NOT NULL
);

-- Rules the user muted (suppressed as noise), optionally scoped to a project or source. A muted rule
-- hides its current AND future findings from the open view — the scalable lever for a noisy rule.
CREATE TABLE IF NOT EXISTS muted_rules (
  rule_id  TEXT NOT NULL,
  scope    TEXT NOT NULL DEFAULT 'global',  -- 'global' | 'project' | 'source'
  scope_id TEXT NOT NULL DEFAULT '',        -- project_id / source_id; '' for global (NOT NULL keeps it in the PK)
  note     TEXT,
  muted_at TEXT NOT NULL,
  PRIMARY KEY (rule_id, scope, scope_id)
);
`;

/** Open (creating if needed) the writable triage DB and ensure its schema. */
export function openTriage(file: string): TriageDB {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(TRIAGE_SCHEMA_SQL);
  return db;
}

const now = () => new Date().toISOString();

/** Mark findings safe (idempotent upsert). Returns the number of ids processed. */
export function dismiss(db: TriageDB, ids: string[], note?: string | null): number {
  const stmt = db.prepare(
    `INSERT INTO dismissed_findings (finding_id, note, dismissed_at) VALUES (?, ?, ?)
     ON CONFLICT(finding_id) DO UPDATE SET note = excluded.note, dismissed_at = excluded.dismissed_at`,
  );
  const ts = now();
  const tx = db.transaction((list: string[]) => {
    for (const id of list) stmt.run(id, note ?? null, ts);
  });
  tx(ids);
  return ids.length;
}

/** Reopen (un-dismiss) findings. Returns the number of rows removed. */
export function reopen(db: TriageDB, ids: string[]): number {
  const stmt = db.prepare("DELETE FROM dismissed_findings WHERE finding_id = ?");
  let n = 0;
  const tx = db.transaction((list: string[]) => {
    for (const id of list) n += stmt.run(id).changes;
  });
  tx(ids);
  return n;
}

export type MuteScope = "global" | "project" | "source";

/** Mute a rule (optionally scoped). Idempotent. */
export function muteRule(db: TriageDB, ruleId: string, scope: MuteScope = "global", scopeId = "", note?: string | null): void {
  db.prepare(
    `INSERT INTO muted_rules (rule_id, scope, scope_id, note, muted_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(rule_id, scope, scope_id) DO UPDATE SET note = excluded.note, muted_at = excluded.muted_at`,
  ).run(ruleId, scope, scope === "global" ? "" : scopeId, note ?? null, now());
}

/** Unmute a rule. Returns rows removed (0 if it wasn't muted at that scope). */
export function unmute(db: TriageDB, ruleId: string, scope: MuteScope = "global", scopeId = ""): number {
  return db
    .prepare("DELETE FROM muted_rules WHERE rule_id = ? AND scope = ? AND scope_id = ?")
    .run(ruleId, scope, scope === "global" ? "" : scopeId).changes;
}

export interface MuteRow {
  rule_id: string;
  scope: string;
  scope_id: string;
  note: string | null;
  muted_at: string;
}

/** All muted rules, newest first — for the management panel. */
export function listMutes(db: TriageDB): MuteRow[] {
  return db.prepare("SELECT rule_id, scope, scope_id, note, muted_at FROM muted_rules ORDER BY muted_at DESC").all() as MuteRow[];
}
