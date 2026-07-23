/**
 * Canonical project roots (ADR-023) — fold cwd-grained project rows into real project roots.
 *
 * Claude Code stamps one project per distinct cwd, so a session (or a spawned subagent) run from a
 * repo SUBDIRECTORY mints a phantom "project" (`repo/packages/x`, `repo/evals`, …) that pollutes
 * every project filter. This re-runnable, global step resolves each project path to its canonical
 * root and merges the rows:
 *
 *   1. Nearest git root wins — walk up from the cwd (inclusive) looking for `.git` (dir OR file, so
 *      worktrees count), never testing $HOME or above (a dotfiles repo in ~ must not swallow every
 *      non-repo path). Nearest match keeps nested repos distinct: `ws/repo/sub` folds to `ws/repo`,
 *      not to `ws`.
 *   2. Fallback: nearest OBSERVED ancestor project — for non-git workspace dirs (`ws/.local` → `ws`
 *      when `ws` was itself a session cwd), resolved to that ancestor's own canonical root. Applies
 *      when the path still exists on disk, OR when the project holds no main session (sidechain
 *      only): for a vanished directory we cannot distinguish a deleted independent repo from a
 *      workspace subdir, so a project a human actually opened (≥1 main session) keeps its identity —
 *      while subagent-only landing spots (spawn cwds, deleted eval/worktree dirs) always fold.
 *   3. Neither → keep the raw cwd (includes $HOME itself and deleted human-opened projects).
 *
 * Merging repoints sessions.project_id (+ file_changes.project_id), refreshes the canonical row's
 * first/last_seen from its merged sessions, and deletes session-less project rows — which also
 * sweeps any true orphans out of the filter dropdowns. Deterministic given the host filesystem;
 * paths that don't exist on this machine simply never match rule 1.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { DB } from "./db.js";

/** Same derivation ingestFile uses (pipeline.ts), so a created canonical row is identical to one
 * that ingest would have minted for that cwd. */
function projectId(agentId: string, path: string): string {
  return createHash("sha1").update(`${agentId}\0${path}`).digest("hex").slice(0, 16);
}

const strip = (p: string) => (p.length > 1 ? p.replace(/\/$/, "") : p);

/** Nearest ancestor (inclusive) containing `.git`, walking up to — but never testing — `home`.
 * Null when none is found before hitting home or the filesystem root. */
function nearestGitRoot(path: string, home: string): string | null {
  let cur = strip(path);
  while (cur !== home && cur !== "/" && cur.length > 0) {
    if (existsSync(join(cur, ".git"))) return cur;
    const next = dirname(cur);
    if (next === cur) break;
    cur = next;
  }
  return null;
}

export interface CanonicalizeResult {
  merged: number; // project rows folded into another
  removed: number; // session-less project rows deleted
}

/**
 * Fold every project row into its canonical root (see module doc). Global and re-runnable on every
 * ingest — the whole table is a few dozen rows — so an already-ingested DB heals on its next run,
 * no --full needed.
 */
export function canonicalizeProjects(db: DB, opts: { homeDir?: string } = {}): CanonicalizeResult {
  const home = strip(opts.homeDir ?? homedir());
  const rows = db.prepare("SELECT id, agent_id, path FROM projects").all() as Array<{
    id: string;
    agent_id: string;
    path: string;
  }>;
  const byPath = new Map<string, { id: string; agent_id: string }>();
  for (const r of rows) byPath.set(strip(r.path), { id: r.id, agent_id: r.agent_id });

  // Projects with at least one MAIN session — a human opened a session there, so a deleted dir
  // keeps its identity (see rule 2 in the module doc). Sidechain-only projects never block folding.
  const withMains = new Set<string>(
    (db.prepare("SELECT DISTINCT project_id FROM sessions WHERE is_sidechain = 0 AND project_id IS NOT NULL").all() as Array<{ project_id: string }>).map(
      (r) => r.project_id,
    ),
  );

  // Resolve a path to its canonical root. Memoized; the ancestor fallback recurses on a strictly
  // shorter path, so it terminates.
  const memo = new Map<string, string>();
  function canon(path: string): string {
    const p = strip(path);
    const hit = memo.get(p);
    if (hit) return hit;
    memo.set(p, p); // provisional (self) — guards pathological cycles
    let out = p;
    if (p !== home) {
      const git = nearestGitRoot(p, home);
      if (git) {
        out = git;
      } else if (existsSync(p) || !withMains.has(byPath.get(p)?.id ?? "")) {
        // Rule 2: nearest observed ancestor project, resolved to ITS canonical root. Gated so a
        // DELETED dir folds only when no human ever opened a session there (sidechain-only) —
        // a deleted real repo must keep its identity, not fold into its parent.
        for (let cur = dirname(p); cur !== "/" && cur !== home && cur.length > 0; cur = dirname(cur)) {
          if (byPath.has(cur)) {
            out = canon(cur);
            break;
          }
          if (dirname(cur) === cur) break;
        }
      }
    }
    memo.set(p, out);
    return out;
  }

  let merged = 0;
  const upsertProject = db.prepare(
    `INSERT INTO projects (id, agent_id, path, encoded_dir, first_seen, last_seen)
     VALUES (?, ?, ?, NULL, NULL, NULL) ON CONFLICT(agent_id, path) DO NOTHING`,
  );
  const repointSessions = db.prepare("UPDATE sessions SET project_id = ? WHERE project_id = ?");
  const repointFileChanges = db.prepare("UPDATE file_changes SET project_id = ? WHERE project_id = ?");
  const touched = new Set<string>();

  db.transaction(() => {
    for (const r of rows) {
      const target = canon(r.path);
      if (target === strip(r.path)) continue;
      const targetId = byPath.get(target)?.id ?? projectId(r.agent_id, target);
      if (targetId === r.id) continue;
      // The canonical root may never have been a cwd itself (sessions only ever ran in subdirs) —
      // mint its row exactly as ingest would have.
      if (!byPath.has(target)) {
        upsertProject.run(targetId, r.agent_id, target);
        byPath.set(target, { id: targetId, agent_id: r.agent_id });
      }
      repointSessions.run(targetId, r.id);
      repointFileChanges.run(targetId, r.id);
      touched.add(targetId);
      merged++;
    }
    // Refresh merged roots' seen-range from their (now larger) session set.
    const refresh = db.prepare(
      `UPDATE projects SET
         first_seen = (SELECT MIN(started_at) FROM sessions WHERE project_id = projects.id),
         last_seen  = (SELECT MAX(COALESCE(ended_at, started_at)) FROM sessions WHERE project_id = projects.id)
       WHERE id = ?`,
    );
    for (const id of touched) refresh.run(id);
  })();

  // Session-less rows — both the just-merged sources and any pre-existing orphans — leave the
  // filter dropdowns for good.
  const removed = db
    .prepare("DELETE FROM projects WHERE id NOT IN (SELECT DISTINCT project_id FROM sessions WHERE project_id IS NOT NULL)")
    .run().changes;

  return { merged, removed };
}
