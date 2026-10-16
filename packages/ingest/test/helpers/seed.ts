/**
 * Fixtures shared by the ingest tests. The tests themselves import the BUILT dist; these helpers only
 * touch node and @agent-lens/core, so they need no build of their own.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "@agent-lens/core";

/** An in-memory DB on the current schema. Foreign keys are OFF: a test seeds only what its pass reads. */
export function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec("PRAGMA foreign_keys = OFF");
  return db;
}

/** Seed a session, optionally under a project at `projectPath` (relative-path resolution, project_id). */
export function addSession(db: DatabaseSync, id: string, projectPath?: string): void {
  if (projectPath) {
    const pid = `p-${id}`;
    db.prepare(`INSERT INTO projects (id, agent_id, path) VALUES (?, 'claude-code', ?)`).run(pid, projectPath);
    db.prepare(`INSERT INTO sessions (id, agent_id, project_id) VALUES (?, 'claude-code', ?)`).run(id, pid);
  } else {
    db.prepare(`INSERT INTO sessions (id, agent_id) VALUES (?, 'claude-code')`).run(id);
  }
}

/** Transcript lines as a JSONL file body. */
export const jsonl = (...lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

/** Every `.jsonl` under `dir`, recursively, sorted — a stable order whatever the filesystem returns. */
export function listJsonl(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listJsonl(p));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out.sort();
}
