/**
 * Agent Lens — shared Stage 2 sidecar-ingest machinery.
 *
 * The three sidecar ingesters (workflow results, subagent meta, spilled tool results) share the same
 * skeleton: recursively find files that live directly inside a named subdir (mirror first, then each
 * `.versions/<ts>/` snapshot), sort so the mirror wins on UPSERT, and run an incremental stat→hash
 * skip against `ingest_state` before handing each *changed* file to a per-sidecar handler. That
 * skeleton was copy-pasted three times (SLOP-011); it lives here once. Each sidecar keeps only its own
 * config: the subdir name, the filename predicate, and the handler that parses + upserts one file.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "./db.js";
import { isExcludedArchivePath } from "./redact.js";
import { sha256 } from "./fileread.js";

/** Counters every sidecar ingester reports (files seen / rows upserted / unchanged / unparseable). */
export interface SidecarStats {
  files: number;
  upserted: number;
  skipped: number;
  malformed: number;
}

export function newSidecarStats(): SidecarStats {
  return { files: 0, upserted: 0, skipped: 0, malformed: 0 };
}

export const intOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null);
export const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The path segment immediately before `<subdir>/` (the launching/owning session id), or null. */
export function sessionBefore(path: string, subdir: string): string | null {
  const parts = path.split("/");
  const i = parts.indexOf(subdir);
  return i > 0 ? parts[i - 1] : null;
}

/** Recursively collect files that sit directly inside a `<subdir>/` directory and match `matchName`. */
function walk(dir: string, subdir: string, inSubdir: boolean, matchName: (name: string) => boolean, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, subdir, inSubdir || e.name === subdir, matchName, out);
    else if (e.isFile() && inSubdir && matchName(e.name)) out.push(p);
  }
}

/** All matching sidecar paths under a source archive (mirror first, then each `.versions` snapshot). */
function discover(sourceArchiveDir: string, subdir: string, matchName: (name: string) => boolean): string[] {
  const out: string[] = [];
  walk(join(sourceArchiveDir, "projects"), subdir, false, matchName, out);
  try {
    for (const ts of readdirSync(join(sourceArchiveDir, ".versions"), { withFileTypes: true }))
      if (ts.isDirectory()) walk(join(sourceArchiveDir, ts.name, "projects"), subdir, false, matchName, out);
  } catch {
    /* no versions yet */
  }
  return out;
}

/** Per-sidecar configuration for {@link ingestSidecars}. */
export interface SidecarConfig {
  /** The directory name whose direct children are sidecars (`workflows` / `subagents` / `tool-results`). */
  subdir: string;
  /** Filename predicate for a sidecar file. */
  matchName: (name: string) => boolean;
  /**
   * Optional pre-stat guard: return false to skip a discovered path entirely (no `files++`) — e.g. a
   * file outside the expected `…/<sessionId>/<subdir>/` layout.
   */
  include?: (path: string) => boolean;
  /**
   * Handle one *changed* file's bytes (`size` is the stat size, for a `bytes` column): parse + upsert.
   * Return true when a row was written (→ counted `upserted` and the file is marked ingested), or false
   * to count it `malformed` and leave it unmarked (so a persistently-bad file is retried, never
   * silently accepted).
   */
  handle: (path: string, buf: Buffer, size: number) => boolean;
}

interface StateRow {
  size: number;
  mtime_ms: number;
  sha256: string;
}

/**
 * Discover, filter, sort, and incrementally skip sidecar files for one source, handing each changed
 * file to `cfg.handle`. Mutates `stats`. `full` forces a re-read (ignores the stat/hash short-circuit).
 */
export function ingestSidecars(
  db: DB,
  sourceArchiveDir: string,
  excludedDirs: string[],
  now: string,
  stats: SidecarStats,
  full: boolean,
  cfg: SidecarConfig,
): void {
  let paths = discover(sourceArchiveDir, cfg.subdir, cfg.matchName);
  if (excludedDirs.length) paths = paths.filter((p) => !isExcludedArchivePath(p, excludedDirs));
  // Mirror last so it wins over any older .versions snapshot on UPSERT (a run that went
  // running→completed diverges: the completed copy is in the mirror).
  paths.sort((a, b) => Number(a.includes("/.versions/")) - Number(b.includes("/.versions/")) || (a < b ? -1 : 1));

  const getState = db.prepare("SELECT size, mtime_ms, sha256 FROM ingest_state WHERE file_path = ?");
  const setState = db.prepare(
    `INSERT INTO ingest_state (file_path, size, mtime_ms, sha256, events_ingested, ingested_at)
     VALUES (@file_path, @size, @mtime_ms, @sha256, 0, @ingested_at)
     ON CONFLICT(file_path) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms, sha256=excluded.sha256, ingested_at=excluded.ingested_at`,
  );

  for (const path of paths) {
    if (cfg.include && !cfg.include(path)) continue;
    stats.files++;
    const st = statSync(path);
    const mtimeMs = Math.trunc(st.mtimeMs);
    const prev = full ? undefined : (getState.get(path) as StateRow | undefined);
    if (prev && prev.size === st.size && prev.mtime_ms === mtimeMs) {
      stats.skipped++;
      continue;
    }
    let buf: Buffer;
    try {
      buf = readFileSync(path);
    } catch {
      stats.malformed++;
      continue;
    }
    const hash = sha256(buf);
    if (prev && prev.sha256 === hash) {
      setState.run({ file_path: path, size: st.size, mtime_ms: mtimeMs, sha256: hash, ingested_at: now });
      stats.skipped++;
      continue;
    }
    if (cfg.handle(path, buf, st.size)) {
      setState.run({ file_path: path, size: st.size, mtime_ms: mtimeMs, sha256: hash, ingested_at: now });
      stats.upserted++;
    } else {
      stats.malformed++;
    }
  }
}
