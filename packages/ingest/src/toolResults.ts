/**
 * Agent Lens — Stage 2 ingest of spilled full tool-result files.
 *
 * When a tool's output is too large for the transcript, Claude Code writes the full output to disk and
 * keeps only a short summary in the transcript naming the file:
 *   <archive>/<source>/projects/<enc>/<sessionId>/tool-results/<name>.txt
 * (the summary reads "Output too large (…). Full output saved to: …/tool-results/<name>.txt"). The
 * basename <name> is NOT the tool_use id — it's a short random token — so we key `tool_results` on
 * (session_id, name) and join at read time by parsing that marker out of tool_calls.result_summary.
 *
 * Idempotent: keyed by (session_id, name), UPSERT on re-ingest; a stat short-circuit (ingest_state)
 * skips unchanged files. Excluded projects are filtered out at discovery. Mirrors `workflows.ts`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DB } from "./db.js";
import { isExcludedArchivePath } from "./redact.js";
import { sha256 } from "./fileread.js";

export interface ToolResultIngestStats {
  files: number;
  upserted: number;
  skipped: number;
  malformed: number;
}

export function newToolResultStats(): ToolResultIngestStats {
  return { files: 0, upserted: 0, skipped: 0, malformed: 0 };
}

/** Recursively find `*.txt` files living directly inside a `tool-results/` directory. */
function walkResults(dir: string, inResults: boolean, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkResults(p, inResults || e.name === "tool-results", out);
    else if (e.isFile() && inResults && e.name.endsWith(".txt")) out.push(p);
  }
}

/** All tool-result paths under a source archive (mirror first, then each .versions snapshot). */
function discoverResults(sourceArchiveDir: string): string[] {
  const out: string[] = [];
  walkResults(join(sourceArchiveDir, "projects"), false, out);
  try {
    for (const ts of readdirSync(join(sourceArchiveDir, ".versions"), { withFileTypes: true }))
      if (ts.isDirectory()) walkResults(join(sourceArchiveDir, ts.name, "projects"), false, out);
  } catch {
    /* no versions yet */
  }
  return out;
}

/** Session id = the path segment immediately before `tool-results/`. */
function sessionFromPath(path: string): string | null {
  const parts = path.split("/");
  const i = parts.indexOf("tool-results");
  return i > 0 ? parts[i - 1] : null;
}

/**
 * Ingest all spilled tool-result files for one source into `tool_results`. `excludedDirs` are the
 * parsed exclude tokens (same filter the transcript walk uses). Returns nothing; mutates `stats`.
 */
export function ingestToolResults(
  db: DB,
  sourceArchiveDir: string,
  excludedDirs: string[],
  now: string,
  stats: ToolResultIngestStats,
  full: boolean,
): void {
  let paths = discoverResults(sourceArchiveDir);
  if (excludedDirs.length) paths = paths.filter((p) => !isExcludedArchivePath(p, excludedDirs));
  // Mirror last so it wins over any older .versions snapshot on UPSERT.
  paths.sort((a, b) => Number(a.includes("/.versions/")) - Number(b.includes("/.versions/")) || (a < b ? -1 : 1));

  const getState = db.prepare("SELECT size, mtime_ms, sha256 FROM ingest_state WHERE file_path = ?");
  const setState = db.prepare(
    `INSERT INTO ingest_state (file_path, size, mtime_ms, sha256, events_ingested, ingested_at)
     VALUES (@file_path, @size, @mtime_ms, @sha256, 0, @ingested_at)
     ON CONFLICT(file_path) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms, sha256=excluded.sha256, ingested_at=excluded.ingested_at`,
  );
  const upsert = db.prepare(
    `INSERT INTO tool_results (session_id, name, path, bytes, text, ingested_at)
     VALUES (@session_id, @name, @path, @bytes, @text, @ingested_at)
     ON CONFLICT(session_id, name) DO UPDATE SET
       path=excluded.path, bytes=excluded.bytes, text=excluded.text, ingested_at=excluded.ingested_at`,
  );

  for (const path of paths) {
    const sessionId = sessionFromPath(path);
    if (!sessionId) continue; // outside the expected …/<sessionId>/tool-results/ layout
    stats.files++;
    const st = statSync(path);
    const mtimeMs = Math.trunc(st.mtimeMs);
    const prev = full ? undefined : (getState.get(path) as { size: number; mtime_ms: number; sha256: string } | undefined);
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

    upsert.run({
      session_id: sessionId,
      name: basename(path, ".txt"),
      path,
      bytes: st.size,
      text: buf.toString("utf8"),
      ingested_at: now,
    });
    setState.run({ file_path: path, size: st.size, mtime_ms: mtimeMs, sha256: hash, ingested_at: now });
    stats.upserted++;
  }
}
