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
 * Idempotent: keyed by (session_id, name), UPSERT on re-ingest. The discover/skip/state machinery is
 * shared with the other sidecar ingesters in `sidecar.ts`; only the upsert below is result-specific.
 */
import { basename } from "node:path";
import type { DB } from "./db.js";
import { ingestSidecars, newSidecarStats, sessionBefore, type SidecarStats } from "./sidecar.js";

export type ToolResultIngestStats = SidecarStats;
export const newToolResultStats = newSidecarStats;

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
  const upsert = db.prepare(
    `INSERT INTO tool_results (session_id, name, path, bytes, text, ingested_at)
     VALUES (@session_id, @name, @path, @bytes, @text, @ingested_at)
     ON CONFLICT(session_id, name) DO UPDATE SET
       path=excluded.path, bytes=excluded.bytes, text=excluded.text, ingested_at=excluded.ingested_at`,
  );

  ingestSidecars(db, sourceArchiveDir, excludedDirs, now, stats, full, {
    subdir: "tool-results",
    matchName: (name) => name.endsWith(".txt"),
    // Skip a file outside the expected …/<sessionId>/tool-results/ layout (no files++, matching the
    // original early-continue before statting).
    include: (path) => sessionBefore(path, "tool-results") !== null,
    handle: (path, buf, size) => {
      const sessionId = sessionBefore(path, "tool-results")!; // include() guaranteed non-null
      upsert.run({
        session_id: sessionId,
        name: basename(path, ".txt"),
        path,
        bytes: size,
        text: buf.toString("utf8"),
        ingested_at: now,
      });
      return true;
    },
  });
}
