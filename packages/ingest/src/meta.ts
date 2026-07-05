/**
 * Agent Lens — Stage 2 ingest of per-subagent metadata sidecars.
 *
 * When a subagent (Task/Agent, or a Workflow fan-out agent) runs, Claude Code writes a metadata
 * sidecar next to its transcript:
 *   <archive>/<source>/projects/<enc>/<sessionId>/subagents/agent-<id>.meta.json
 * carrying { agentType, description, spawnDepth?, toolUseId }. This is the authoritative source of a
 * subagent's type and human title — Workflow fan-out agents carry no subagent_type on the launching
 * tool_call, so ~700 of them are otherwise untyped. The filename stem `agent-<id>` IS the subagent's
 * session id (the same id `discover()` assigns the transcript), so we key `session_meta` on it and
 * LEFT JOIN at read time (no dependency on the session row existing yet).
 *
 * Idempotent: keyed by session id, UPSERT on re-ingest; a stat short-circuit (ingest_state) skips
 * unchanged files. Excluded projects are filtered out at discovery. Mirrors `workflows.ts`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DB } from "./db.js";
import { isExcludedArchivePath } from "./redact.js";
import { sha256 } from "./fileread.js";

export interface MetaIngestStats {
  files: number;
  upserted: number;
  skipped: number;
  malformed: number;
}

export function newMetaStats(): MetaIngestStats {
  return { files: 0, upserted: 0, skipped: 0, malformed: 0 };
}

/** Recursively find `agent-*.meta.json` sidecars living directly inside a `subagents/` directory. */
function walkMeta(dir: string, inSubagents: boolean, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkMeta(p, inSubagents || e.name === "subagents", out);
    else if (e.isFile() && inSubagents && /^agent-.+\.meta\.json$/.test(e.name)) out.push(p);
  }
}

/** All meta paths under a source archive (mirror first, then each .versions snapshot). */
function discoverMeta(sourceArchiveDir: string): string[] {
  const out: string[] = [];
  walkMeta(join(sourceArchiveDir, "projects"), false, out);
  try {
    for (const ts of readdirSync(join(sourceArchiveDir, ".versions"), { withFileTypes: true }))
      if (ts.isDirectory()) walkMeta(join(sourceArchiveDir, ts.name, "projects"), false, out);
  } catch {
    /* no versions yet */
  }
  return out;
}

const intOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * Ingest all subagent meta sidecars for one source into `session_meta`. `excludedDirs` are the parsed
 * exclude tokens (same filter the transcript walk uses). Returns nothing; mutates `stats`.
 */
export function ingestSubagentMeta(
  db: DB,
  sourceArchiveDir: string,
  sourceId: string,
  excludedDirs: string[],
  now: string,
  stats: MetaIngestStats,
  full: boolean,
): void {
  let paths = discoverMeta(sourceArchiveDir);
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
    `INSERT INTO session_meta
       (session_id, source_id, agent_type, agent_description, spawn_depth, tool_use_id, ingested_at)
     VALUES
       (@session_id, @source_id, @agent_type, @agent_description, @spawn_depth, @tool_use_id, @ingested_at)
     ON CONFLICT(session_id) DO UPDATE SET
       source_id=excluded.source_id, agent_type=excluded.agent_type,
       agent_description=excluded.agent_description, spawn_depth=excluded.spawn_depth,
       tool_use_id=excluded.tool_use_id, ingested_at=excluded.ingested_at`,
  );

  for (const path of paths) {
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

    let d: any;
    try {
      d = JSON.parse(buf.toString("utf8"));
    } catch {
      stats.malformed++;
      continue;
    }
    if (!d || typeof d !== "object") {
      stats.malformed++;
      continue;
    }

    // Filename stem is the subagent's session id: `agent-<id>.meta.json` → `agent-<id>`.
    const sessionId = basename(path, ".meta.json");
    upsert.run({
      session_id: sessionId,
      source_id: sourceId,
      agent_type: strOrNull(d.agentType),
      agent_description: strOrNull(d.description),
      spawn_depth: intOrNull(d.spawnDepth),
      tool_use_id: strOrNull(d.toolUseId),
      ingested_at: now,
    });
    setState.run({ file_path: path, size: st.size, mtime_ms: mtimeMs, sha256: hash, ingested_at: now });
    stats.upserted++;
  }
}
