/** The Files list and one file's change timeline (ADR-022). */
import type { FileSummary, FileTimeline, FileTimelineSession, FilesPage, FileSort } from "@agent-lens/contracts";
import { tableExists, queryAll, queryGet, orderBy, whereClause, enumValues, type SortDir } from "../sql-util.js";
import type { CategoryRow, CountRow, FileTimelineRow } from "../rows.js";
import { type DB, displayTitle } from "./common.js";

// The values this endpoint accepts for `?sort=`. The union lives in @agent-lens/contracts so the web
// views share it; this is the runtime allowlist app.ts parses the query against, checked against
// the union in both directions by enumValues.
export const FILE_SORTS = enumValues<FileSort>({ last_ts: true, first_ts: true, changes: true, sessions: true, path: true });

export interface FileFilters {
  q?: string; // path substring
  source?: string;
  project?: string;
  sort?: FileSort;
  dir?: SortDir;
  limit?: number;
  offset?: number;
}

/**
 * The /files list (ADR-022): one row per (project, file) aggregated from `file_changes` — session
 * and change counts, line totals, first/last touched. Filters mirror the sessions list (source via
 * the changing session; q is a path substring). Sort whitelist is native SQL; count-then-page like
 * listSessions. Empty result (not an error) on a pre-v14 DB missing the table.
 */
export function listFiles(db: DB, f: FileFilters = {}): FilesPage {
  if (!tableExists(db, "file_changes")) return { total: 0, files: [] };
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.q && f.q.trim()) (where.push("fc.file_path LIKE ?"), params.push(`%${f.q.trim()}%`));
  if (f.project) (where.push("fc.project_id = ?"), params.push(f.project));
  if (f.source) (where.push("EXISTS (SELECT 1 FROM sessions s WHERE s.id = fc.session_id AND s.source_id = ?)"), params.push(f.source));
  const whereSql = whereClause(where);

  const grouped = `SELECT fc.project_id, fc.file_path,
       COUNT(DISTINCT fc.session_id) AS sessions,
       COUNT(*) AS changes,
       SUM(fc.lines_added) AS lines_added,
       SUM(fc.lines_removed) AS lines_removed,
       MIN(fc.timestamp) AS first_ts,
       MAX(fc.timestamp) AS last_ts
     FROM file_changes fc ${whereSql}
     GROUP BY fc.project_id, fc.file_path`;

  const total = queryGet<CountRow>(db, `SELECT COUNT(*) n FROM (${grouped})`, ...params)!.n;

  const ORDER = {
    last_ts: "last_ts",
    first_ts: "first_ts",
    changes: "changes",
    sessions: "sessions",
    path: "file_path",
  };
  const limit = Math.min(f.limit ?? 50, 200);
  const offset = f.offset ?? 0;

  const files = queryAll<FileSummary>(
    db,
    `SELECT g.*, p.path AS project_path FROM (${grouped}) g
     LEFT JOIN projects p ON p.id = g.project_id
     ORDER BY ${orderBy(ORDER, f.sort, "last_ts", f.dir)}, g.file_path ASC LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );
  return { total, files };
}

/**
 * One file's provenance timeline (ADR-022): every `file_changes` row for the path (optionally
 * scoped to a project), grouped by changing session (newest-first) with per-turn detail — each
 * change deep-links to its tool call's transcript event (#ev-<event_uuid>). Session cards carry
 * title/date/category (classification join) like the skills detail. Returns null (→ 404) when the
 * path has no recorded changes.
 */
export function getFileTimeline(db: DB, filePath: string, projectId?: string): FileTimeline | null {
  if (!tableExists(db, "file_changes")) return null;
  const params: unknown[] = [filePath];
  let scope = "fc.file_path = ?";
  if (projectId) (scope += " AND fc.project_id = ?"), params.push(projectId);
  const rows = queryAll<FileTimelineRow>(
    db,
    `SELECT fc.id, fc.session_id, fc.turn_id, fc.event_uuid, fc.tool_name, fc.lines_added,
            fc.lines_removed, fc.timestamp, fc.project_id,
            s.ai_title, s.slug, s.source_id, s.started_at, t.seq AS turn_seq, t.prompt_preview,
            p.path AS project_path
     FROM file_changes fc
     JOIN sessions s ON s.id = fc.session_id
     LEFT JOIN turns t ON t.id = fc.turn_id
     LEFT JOIN projects p ON p.id = fc.project_id
     WHERE ${scope} ORDER BY fc.timestamp`,
    ...params,
  );
  if (!rows.length) return null;

  const cat = tableExists(db, "classifications")
    ? db.prepare("SELECT category FROM classifications WHERE scope = 'session' AND target_id = ?")
    : null;

  const bySession = new Map<string, FileTimelineSession>();
  for (const r of rows) {
    let g = bySession.get(r.session_id);
    if (!g) {
      g = {
        session_id: r.session_id,
        title: displayTitle(r.ai_title, r.slug),
        source_id: r.source_id,
        started_at: r.started_at,
        category: cat ? ((cat.get(r.session_id) as CategoryRow | undefined)?.category ?? null) : null,
        changes: [],
      };
      bySession.set(r.session_id, g);
    }
    g.changes.push({
      id: r.id,
      turn_id: r.turn_id,
      turn_seq: r.turn_seq,
      prompt_preview: r.prompt_preview,
      event_uuid: r.event_uuid,
      tool_name: r.tool_name,
      lines_added: r.lines_added,
      lines_removed: r.lines_removed,
      timestamp: r.timestamp,
    });
  }
  // Newest-changing session first; changes within a session stay chronological.
  const sessions = [...bySession.values()].sort((a, b) => {
    const la = a.changes[a.changes.length - 1].timestamp ?? "";
    const lb = b.changes[b.changes.length - 1].timestamp ?? "";
    return la < lb ? 1 : la > lb ? -1 : 0;
  });

  return {
    file_path: filePath,
    project_id: rows[0].project_id ?? null,
    project_path: rows[0].project_path ?? null,
    sessions_count: sessions.length,
    changes_count: rows.length,
    lines_added: rows.reduce((a, r) => a + (r.lines_added ?? 0), 0),
    lines_removed: rows.reduce((a, r) => a + (r.lines_removed ?? 0), 0),
    first_ts: rows[0].timestamp ?? null,
    last_ts: rows[rows.length - 1].timestamp ?? null,
    sessions,
  };
}
