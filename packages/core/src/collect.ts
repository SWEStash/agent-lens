/**
 * Agent Lens — Stage 1 collection, in portable Node (ADR-001, ADR-002, ADR-005).
 *
 * Passively copies agent session traces out of each configured source into the local archive before
 * the agent prunes them. Never deletes, never sends data off the machine, never copies secrets. This
 * replaces the bash+rsync collect.sh with the same semantics, minus the Linux-only dependencies.
 *
 * Per file (mirror of rsync --append-verify + the .versions pre-pass):
 *   - no archive copy yet                         → copy whole
 *   - unchanged since last collect (size + mtime) → skip
 *   - source ≥ archive AND archive is a byte-prefix→ append the new tail (pure append)
 *   - source shorter than archive (compaction)    → snapshot the SOURCE to .versions/<ts>/, keep the
 *                                                    longer archive (no shrink → retains history)
 *   - same-or-longer but prefix differs (divergence) → snapshot the OLD archive, overwrite with source
 * Stage 2 ingests the mirror AND .versions/, deduping events by uuid → maximal history.
 *
 * Secrets (.credentials.json, *.lock) are never copied; a post-pass also removes any stray
 * .credentials.json from the archive. Excluded projects (loadExcludes) are never mirrored.
 */
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
  chmodSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { platform } from "node:os";
import { loadExcludes, loadSources, type Source } from "./sources.js";
import { findRepoRoot, resolveDataDir } from "./paths.js";
import { encodeProjectPath } from "./projects.js";

const POSIX = platform() !== "win32";
const DIR_MODE = 0o700; // archive is as sensitive as the originals (bash used umask 077)
const FILE_MODE = 0o600;
const CHUNK = 1 << 16;

export interface CollectOptions {
  /** Archive base dir. Default: `<dataDir>/archive`. */
  archiveBase?: string;
  /** Sources to collect. Default: loadSources(). */
  sources?: Source[];
  /** Real project paths to exclude. Default: loadExcludes(). */
  excludes?: string[];
  /** Shared run timestamp for .versions/<ts>/. Default: now (local time). */
  runTimestamp?: string;
  /** Progress sink. Default: console.log. */
  log?: (msg: string) => void;
}

export interface CollectStats {
  sources: number;
  scanned: number;
  copied: number;
  appended: number;
  diverged: number;
  compacted: number;
  snapshots: number;
}

/** `YYYYMMDDTHHMMSSmmm` in local time (matches `date +%Y%m%dT%H%M%S%3N`). */
export function collectTimestamp(d: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`
  );
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

/** Set archive file perms + mtime to mirror the source (like rsync -a / cp -p). */
function syncMeta(dst: string, src: Stats): void {
  if (POSIX) {
    try {
      chmodSync(dst, FILE_MODE);
    } catch {
      /* best effort */
    }
  }
  try {
    utimesSync(dst, src.atime, src.mtime);
  } catch {
    /* best effort */
  }
}

function copyWhole(src: string, dst: string, srcStat: Stats): void {
  ensureDir(dirname(dst));
  copyFileSync(src, dst);
  syncMeta(dst, srcStat);
}

/** True if the first `len` bytes of `src` byte-equal the whole of `arc` (`arc` is `len` bytes). */
function prefixEquals(src: string, arc: string, len: number): boolean {
  const sf = openSync(src, "r");
  const af = openSync(arc, "r");
  try {
    const sb = Buffer.allocUnsafe(CHUNK);
    const ab = Buffer.allocUnsafe(CHUNK);
    let remaining = len;
    while (remaining > 0) {
      const want = Math.min(CHUNK, remaining);
      const sr = readSync(sf, sb, 0, want, null);
      const ar = readSync(af, ab, 0, want, null);
      if (sr !== ar || sr === 0) return false;
      if (Buffer.compare(sb.subarray(0, sr), ab.subarray(0, sr)) !== 0) return false;
      remaining -= sr;
    }
    return remaining === 0;
  } finally {
    closeSync(sf);
    closeSync(af);
  }
}

/** Append `src[from..to)` to the end of `arc`. */
function appendRange(src: string, arc: string, from: number, to: number): void {
  const sf = openSync(src, "r");
  const af = openSync(arc, "a");
  try {
    const b = Buffer.allocUnsafe(CHUNK);
    let pos = from;
    while (pos < to) {
      const want = Math.min(CHUNK, to - pos);
      const r = readSync(sf, b, 0, want, pos);
      if (r === 0) break;
      writeSync(af, b, 0, r);
      pos += r;
    }
  } finally {
    closeSync(sf);
    closeSync(af);
  }
}

function filesEqual(a: string, b: string): boolean {
  const sa = statSync(a);
  const sb = statSync(b);
  if (sa.size !== sb.size) return false;
  return prefixEquals(a, b, sa.size);
}

/** Most recent `.versions/<ts>/<rel>` snapshot for `rel`, or null. Timestamps sort chronologically. */
function latestSnapshot(archive: string, relParts: string[]): string | null {
  const versRoot = join(archive, ".versions");
  if (!existsSync(versRoot)) return null;
  const stamps = readdirSync(versRoot).sort();
  for (let i = stamps.length - 1; i >= 0; i--) {
    const p = join(versRoot, stamps[i]!, ...relParts);
    if (existsSync(p)) return p;
  }
  return null;
}

function snapshot(absPath: string, relParts: string[], versionsDir: string, stats: CollectStats): void {
  const dst = join(versionsDir, ...relParts);
  ensureDir(dirname(dst));
  copyFileSync(absPath, dst);
  syncMeta(dst, statSync(absPath));
  stats.snapshots++;
}

/** Recursively collect *.jsonl files under `dir`. */
function walkJsonl(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
}

/** The single-file sync decision (the heart of the append-verify port). */
function syncFile(src: string, dst: string, relParts: string[], archive: string, versionsDir: string, stats: CollectStats): void {
  const srcStat = statSync(src);
  if (!existsSync(dst)) {
    copyWhole(src, dst, srcStat);
    stats.copied++;
    return;
  }
  const arcStat = statSync(dst);
  // Unchanged since last collect (we preserve source mtime on write, like rsync -a) → skip, no read.
  if (srcStat.size === arcStat.size && Math.trunc(srcStat.mtimeMs) === Math.trunc(arcStat.mtimeMs)) return;

  const ssize = srcStat.size;
  const asize = arcStat.size;
  if (ssize >= asize && prefixEquals(src, dst, asize)) {
    // Pure append (or identical when ssize === asize → appends nothing). Always verify the full
    // prefix before appending; never trust size alone.
    if (ssize > asize) {
      appendRange(src, dst, asize, ssize);
      stats.appended++;
    }
    syncMeta(dst, srcStat);
  } else if (ssize < asize) {
    // Compaction: keep the longer archive; snapshot the compacted source (skip if an identical
    // snapshot already exists, so a stuck-compacted file doesn't re-snapshot every run).
    const last = latestSnapshot(archive, relParts);
    if (!last || !filesEqual(last, src)) snapshot(src, relParts, versionsDir, stats);
    stats.compacted++;
  } else {
    // Divergence: capture the old archive, then overwrite with the source.
    snapshot(dst, relParts, versionsDir, stats);
    copyWhole(src, dst, srcStat);
    stats.diverged++;
  }
}

function removeCredentials(dir: string): void {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) removeCredentials(p);
    else if (e.name === ".credentials.json") {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

function collectSource(
  source: Source,
  archiveBase: string,
  excludedDirs: string[],
  runTs: string,
  stats: CollectStats,
  log: (m: string) => void,
): void {
  const { label, configDir } = source;
  const archive = join(archiveBase, label);
  const versionsDir = join(archive, ".versions", runTs);
  if (!existsSync(configDir)) {
    log(`agent-lens: [${label}] source not found: ${configDir} (skipping)`);
    return;
  }
  ensureDir(join(archive, "projects"));
  ensureDir(join(archive, "settings"));

  const files: string[] = [];
  const projectsDir = join(configDir, "projects");
  if (existsSync(projectsDir)) walkJsonl(projectsDir, files);
  const historySrc = join(configDir, "history.jsonl");
  if (existsSync(historySrc)) files.push(historySrc);

  const before = { scanned: stats.scanned, snapshots: stats.snapshots };
  for (const src of files) {
    const base = basename(src);
    if (base === ".credentials.json" || base.endsWith(".lock")) continue; // never copy secrets
    const relParts = relative(configDir, src).split(sep);
    const relPosix = relParts.join("/");
    if (excludedDirs.some((enc) => relPosix.startsWith(`projects/${enc}/`))) continue; // excluded project
    stats.scanned++;
    syncFile(src, join(archive, ...relParts), relParts, archive, versionsDir, stats);
  }

  // Settings: latest-wins, snapshot old on change.
  for (const f of ["settings.json", "settings.local.json"]) {
    const s = join(configDir, f);
    if (!existsSync(s)) continue;
    const a = join(archive, "settings", f);
    if (existsSync(a) && !filesEqual(s, a)) snapshot(a, ["settings", f], versionsDir, stats);
    ensureDir(dirname(a));
    copyFileSync(s, a);
    syncMeta(a, statSync(s));
  }

  removeCredentials(archive);

  const scanned = stats.scanned - before.scanned;
  const snapshots = stats.snapshots - before.snapshots;
  const line = `${new Date().toISOString()} run=${runTs} source=${label} scanned=${scanned} snapshots=${snapshots} archive=${archive}`;
  log(`agent-lens: ${line}`);
  try {
    appendFileSync(join(archiveBase, ".collect.log"), line + "\n");
  } catch {
    /* log is best-effort */
  }
}

/** Collect every configured source into the archive. Returns aggregate counters. */
export function collectAll(opts: CollectOptions = {}): CollectStats {
  const log = opts.log ?? ((m: string) => console.log(m));
  const archiveBase = opts.archiveBase ?? join(resolveDataDir(findRepoRoot()), "archive");
  const sources = opts.sources ?? loadSources();
  const excludedDirs = (opts.excludes ?? loadExcludes()).map(encodeProjectPath);
  const runTs = opts.runTimestamp ?? collectTimestamp();

  ensureDir(archiveBase);
  const stats: CollectStats = { sources: 0, scanned: 0, copied: 0, appended: 0, diverged: 0, compacted: 0, snapshots: 0 };
  if (!sources.length) throw new Error("no sources configured");
  for (const source of sources) {
    stats.sources++;
    collectSource(source, archiveBase, excludedDirs, runTs, stats, log);
  }
  return stats;
}
