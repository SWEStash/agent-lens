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
 * Idempotent: keyed by session id, UPSERT on re-ingest. The discover/skip/state machinery is shared
 * with the other sidecar ingesters in `sidecar.ts`; only the parse + upsert below is meta-specific.
 */
import { basename } from "node:path";
import type { DB } from "./db.js";
import { ingestSidecars, newSidecarStats, intOrNull, strOrNull, type SidecarStats } from "./sidecar.js";

export type MetaIngestStats = SidecarStats;
export const newMetaStats = newSidecarStats;

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

  ingestSidecars(db, sourceArchiveDir, excludedDirs, now, stats, full, {
    subdir: "subagents",
    matchName: (name) => /^agent-.+\.meta\.json$/.test(name),
    handle: (path, buf) => {
      let d: Record<string, unknown>;
      try {
        const parsed = JSON.parse(buf.toString("utf8"));
        if (!parsed || typeof parsed !== "object") return false;
        d = parsed as Record<string, unknown>;
      } catch {
        return false;
      }
      // Filename stem is the subagent's session id: `agent-<id>.meta.json` → `agent-<id>`.
      upsert.run({
        session_id: basename(path, ".meta.json"),
        source_id: sourceId,
        agent_type: strOrNull(d.agentType),
        agent_description: strOrNull(d.description),
        spawn_depth: intOrNull(d.spawnDepth),
        tool_use_id: strOrNull(d.toolUseId),
        ingested_at: now,
      });
      return true;
    },
  });
}
