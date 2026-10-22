/**
 * Retention pruning (ADR-009): delete `.versions/<TS>/` snapshot dirs under the archive once they age
 * past the retention window.
 *
 * This is the only archive growth that is both unbounded and safe to discard. The `projects/` mirror
 * is the retained dataset and is never pruned, and the SQLite DB is a derived projection (rebuild with
 * `agent-lens ingest --full` if a prune ever changes what is available).
 *
 * Dry run unless `apply` is set. Only `<archive>/<label>/.versions/<TS>/` dirs are ever considered.
 */
import { appendFileSync, existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "./user-error.js";

export interface PruneOptions {
  archiveBase: string;
  keepDays: number;
  apply: boolean;
  /** Injected for tests. */
  now?: Date;
}

export interface PruneCandidate {
  path: string;
  ageDays: number;
  bytes: number;
}

export interface PruneReport {
  scanned: number;
  candidates: PruneCandidate[];
  bytes: number;
}

/** A snapshot dir's creation time. The name is the collector's run stamp (`YYYYMMDDTHHMMSSmmm`, local
 * time); a dir whose name doesn't parse falls back to its mtime. */
export function snapshotTime(dir: string, name: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{0,3})$/.exec(name);
  if (m) {
    const [, y, mo, d, h, mi, s, ms] = m.map(Number) as number[];
    const t = new Date(y!, mo! - 1, d!, h!, mi!, s!, ms || 0).getTime();
    if (Number.isFinite(t)) return t;
  }
  return statSync(dir).mtimeMs;
}

/** Total size of a directory tree, without following symlinks. */
function treeBytes(path: string): number {
  const st = lstatSync(path);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of readdirSync(path)) total += treeBytes(join(path, name));
  return total;
}

function subdirs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export function pruneVersions(opts: PruneOptions): PruneReport {
  const { archiveBase, keepDays, apply } = opts;
  if (!Number.isInteger(keepDays) || keepDays < 0) throw new UserError("--days must be a non-negative integer");
  if (!existsSync(archiveBase)) throw new UserError(`archive not found: ${archiveBase} (run \`agent-lens collect\` first)`);

  const now = (opts.now ?? new Date()).getTime();
  const cutoff = now - keepDays * 86_400_000;
  const report: PruneReport = { scanned: 0, candidates: [], bytes: 0 };

  for (const label of subdirs(archiveBase)) {
    const versions = join(archiveBase, label, ".versions");
    if (!existsSync(versions) || !lstatSync(versions).isDirectory()) continue;
    for (const name of subdirs(versions)) {
      const snap = join(versions, name);
      report.scanned++;
      const t = snapshotTime(snap, name);
      if (t >= cutoff) continue;
      const bytes = treeBytes(snap);
      report.candidates.push({ path: snap, ageDays: Math.floor((now - t) / 86_400_000), bytes });
      report.bytes += bytes;
      if (apply) rmSync(snap, { recursive: true, force: true });
    }
  }

  const line =
    `${new Date(now).toISOString()} mode=${apply ? "apply" : "dry-run"} keep_days=${keepDays} ` +
    `scanned=${report.scanned} pruned=${report.candidates.length} bytes=${report.bytes}\n`;
  appendFileSync(join(archiveBase, ".prune.log"), line, { mode: 0o600 });
  return report;
}
