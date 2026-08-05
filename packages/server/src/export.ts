/**
 * Session → shareable Markdown, shared by the HTTP route and the CLI `export` command so the
 * DB-row → MarkdownEvent mapping and filename convention live in exactly one place.
 * Redaction defaults ON (selective secret/PII masking); see @agent-lens/core exportMarkdown.
 */
import { exportMarkdown, type MarkdownEvent, type RedactionLevel } from "@agent-lens/core";
import { type DB, getSession } from "./db.js";

/** Normalize a raw ?redact= / --level value to a valid level, defaulting to the safe `secrets`. */
export function parseRedactionLevel(raw: string | undefined): RedactionLevel | "off" {
  return raw === "off" ? "off" : raw === "structure" ? "structure" : "secrets";
}

/** Render session `id` to Markdown at the given level, or null if the session doesn't exist. */
export function renderSessionExport(
  db: DB,
  id: string,
  level: RedactionLevel | "off",
): { markdown: string; filename: string } | null {
  const result = getSession(db, id);
  if (!result) return null;
  const s = result.session;
  const events: MarkdownEvent[] = result.events.map((e) => ({
    type: e.type,
    role: e.role,
    timestamp: e.timestamp,
    text: e.text,
    thinking: e.thinking,
    toolCalls: e.toolCalls.map((t: any) => ({
      tool_name: t.tool_name,
      skill_name: t.skill_name,
      agent_type: t.agent_type,
      input_json: t.input_json,
      status: t.status,
    })),
  }));
  const { markdown } = exportMarkdown(
    { id: s.id, title: s.title, source: s.source_id, project: s.project_path, model: null, started_at: s.started_at, ended_at: s.ended_at },
    events,
    { level },
  );
  const suffix = level === "off" ? "" : ".redacted";
  return { markdown, filename: `session-${filenameSafe(id.slice(0, 8))}${suffix}.md` };
}

/**
 * Reduce a session id to characters that are safe in a `content-disposition` filename.
 *
 * The header is built by interpolation — `attachment; filename="<name>"` (app.ts) — so a `"` in the
 * id would close the quoted-string early and the rest would be parsed as header parameters. Ids are
 * ours today (uuids and slugs), which makes this defence-in-depth rather than a live hole, but the id
 * is a path segment the caller supplies and nothing else validates it before it reaches the header.
 * Sanitizing at the point the filename is BUILT keeps the guarantee with the naming convention
 * instead of leaving it to every future caller of this function.
 *
 * Anything outside `[A-Za-z0-9._-]` collapses to `_`, including the CR/LF that would otherwise permit
 * header injection. An id that is entirely unsafe still yields a usable name rather than an empty one.
 */
function filenameSafe(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned === "" ? "session" : cleaned;
}
