/**
 * File-modification provenance (ADR-022, level 1) — derive `file_changes` rows from successful
 * Edit/Write/NotebookEdit tool calls' verbatim input_json, plus the unambiguous file writes a Bash
 * call performs (shellwrites.ts).
 *
 * Deterministic and re-runnable, modeled on detect.ts: 0..N rows per tool call ⇒ incremental runs
 * delete-then-insert the dirty sessions' rows; null/undefined dirty ⇒ full rescan. Failed calls
 * (status='error') are skipped — a failed edit did not change the file.
 *
 * Bash was originally scoped out here as a lower-confidence class, but profiling showed that left a
 * third of main sessions changing project files invisibly, so the constructs that ARE unambiguous
 * from the command text (heredoc writes, tee, sed -i, echo/printf redirects) now derive rows too.
 * The genuinely ambiguous rest stays out — see shellwrites.ts for what is excluded and why.
 * Deletions and renames remain level 2's git-composed territory.
 */
import { createHash } from "node:crypto";
import { posix as path } from "node:path";
import { transaction } from "@agent-lens/core";
import { parseShellWrites } from "./shellwrites.js";
import type { DB } from "./db.js";

export const FILECHANGES_VERSION = 2;

const FILE_TOOLS = ["Edit", "Write", "NotebookEdit", "Bash"] as const;

/** Deterministic row id — stable across runs so re-derivation reproduces identical rows. */
function fileChangeId(toolCallId: string, filePath: string): string {
  return createHash("sha1").update(toolCallId).update("\0").update(filePath).digest("hex").slice(0, 16);
}

/**
 * Resolve a tool call's target path to a normalized absolute path, or null when unusable.
 * Absolute paths are posix-normalized (`/a/b/../c` → `/a/c`); relative paths resolve against the
 * session's project root when known (the same stance as detect.ts's outsideProjectPath) and are
 * skipped otherwise — a path we can't anchor would poison per-file grouping with false identities.
 */
export function normalizeFilePath(filePath: unknown, projectPath: string | null): string | null {
  if (typeof filePath !== "string" || !filePath) return null;
  if (filePath.startsWith("/")) return path.normalize(filePath);
  if (!projectPath) return null;
  return path.normalize(projectPath.replace(/\/$/, "") + "/" + filePath);
}

/** Count the lines a string spans (1 + newlines); 0 for the empty string. */
function lineCount(s: unknown): number | null {
  if (typeof s !== "string") return null;
  if (s === "") return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

interface ToolRow {
  id: string;
  session_id: string;
  turn_id: string | null;
  event_uuid: string | null;
  tool_name: string;
  input_json: string | null;
  status: string | null;
  timestamp: string | null;
}

/**
 * (Re)derive tool-call file modifications into `file_changes`. Returns row count + version.
 * `dirty` (the expanded id set rebuildDerived returns) scopes an incremental run to the touched
 * sessions via delete-then-insert; null/undefined → derive everything.
 */
export function deriveFileChanges(db: DB, dirty?: Set<string> | null): { count: number; version: number } {
  const incremental = dirty != null;
  if (incremental) {
    db.exec("DROP TABLE IF EXISTS _dirty_fc");
    db.exec("CREATE TEMP TABLE _dirty_fc (id TEXT PRIMARY KEY)");
    const ins = db.prepare("INSERT OR IGNORE INTO _dirty_fc (id) VALUES (?)");
    transaction(db, (ids: Iterable<string>) => {
      for (const id of ids) ins.run(id);
    })(dirty);
  }
  const scope = incremental ? " AND tc.session_id IN (SELECT id FROM _dirty_fc)" : "";

  // Project path + id per (scoped) session — to resolve relative paths and stamp project_id.
  const proj = new Map<string, { id: string; path: string }>();
  for (const r of db
    .prepare(
      `SELECT s.id id, p.id pid, p.path path FROM sessions s JOIN projects p ON p.id = s.project_id${
        incremental ? " WHERE s.id IN (SELECT id FROM _dirty_fc)" : ""
      }`,
    )
    .all() as Array<{ id: string; pid: string; path: string }>) {
    proj.set(r.id, { id: r.pid, path: r.path });
  }

  const rows = db
    .prepare(
      `SELECT tc.id, tc.session_id, tc.turn_id, tc.event_uuid, tc.tool_name, tc.input_json, tc.status, e.timestamp
       FROM tool_calls tc LEFT JOIN events e ON e.uuid = tc.event_uuid
       WHERE tc.tool_name IN (${FILE_TOOLS.map(() => "?").join(",")})${scope}`,
    )
    .all(...FILE_TOOLS) as unknown as ToolRow[];

  const insert = db.prepare(
    `INSERT INTO file_changes (id, tool_call_id, session_id, turn_id, event_uuid, project_id, file_path, tool_name, lines_added, lines_removed, timestamp, derive_version)
     VALUES (@id, @tool_call_id, @session_id, @turn_id, @event_uuid, @project_id, @file_path, @tool_name, @lines_added, @lines_removed, @timestamp, @derive_version)
     ON CONFLICT(id) DO NOTHING`,
  );
  const delScope = incremental
    ? "DELETE FROM file_changes WHERE session_id IN (SELECT id FROM _dirty_fc)"
    : "DELETE FROM file_changes";

  const tx = transaction(db, () => {
    db.exec(delScope);
    for (const row of rows) {
      if (row.status === "error") continue; // a failed call did not change the file
      let input: any = null;
      try {
        input = row.input_json ? JSON.parse(row.input_json) : null;
      } catch {
        input = null;
      }
      if (!input) continue;
      const p = proj.get(row.session_id);

      // One entry per file the call touched — the file tools write exactly one, a Bash call may
      // write several. Magnitude is a signal only, not a diff: newline counts of the verbatim
      // strings. Edit with replace_all counts the strings once (occurrence count is unknowable from
      // the input alone); Write's prior content is unseen, so removed stays NULL; NotebookEdit and
      // in-place shell edits carry no line info at all.
      const targets: Array<{ filePath: string; added: number | null; removed: number | null }> = [];
      if (row.tool_name === "Bash") {
        // A leading `cd` is the command's own cwd and outranks the session's project root.
        const { cwd, writes } = parseShellWrites(input.command);
        for (const w of writes) {
          const filePath = normalizeFilePath(w.path, cwd ?? p?.path ?? null);
          if (filePath) targets.push({ filePath, added: w.linesAdded, removed: null });
        }
      } else {
        const filePath = normalizeFilePath(input.file_path ?? input.notebook_path, p?.path ?? null);
        if (filePath) {
          targets.push({
            filePath,
            added: row.tool_name === "Edit" ? lineCount(input.new_string) : row.tool_name === "Write" ? lineCount(input.content) : null,
            removed: row.tool_name === "Edit" ? lineCount(input.old_string) : null,
          });
        }
      }

      for (const t of targets) {
        insert.run({
          id: fileChangeId(row.id, t.filePath),
          tool_call_id: row.id,
          session_id: row.session_id,
          turn_id: row.turn_id,
          event_uuid: row.event_uuid,
          project_id: p?.id ?? null,
          file_path: t.filePath,
          tool_name: row.tool_name,
          lines_added: t.added,
          lines_removed: t.removed,
          timestamp: row.timestamp,
          derive_version: FILECHANGES_VERSION,
        });
      }
    }
  });
  tx();

  if (incremental) db.exec("DROP TABLE IF EXISTS _dirty_fc");
  const count = (db.prepare("SELECT COUNT(*) n FROM file_changes").get() as { n: number }).n;
  return { count, version: FILECHANGES_VERSION };
}
