/**
 * Encode a real project path the way Claude Code names its `projects/<encodedDir>` folder: every
 * `/` and `.` becomes `-` (e.g. `/home/u/git/agent-lens` → `-home-u-git-agent-lens`). Trailing
 * separators are dropped so a path with or without a trailing slash encodes identically.
 *
 * Canonical here in core so collect (Stage 1) and ingest/redact (Stage 2 / corpus) agree exactly.
 */
export function encodeProjectPath(p: string): string {
  return p.replace(/[/.]/g, "-").replace(/-+$/, "");
}
