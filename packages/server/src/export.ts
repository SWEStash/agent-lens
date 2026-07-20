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
  return { markdown, filename: `session-${id.slice(0, 8)}${suffix}.md` };
}
