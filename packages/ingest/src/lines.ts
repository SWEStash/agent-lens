/**
 * Lines a string spans, git's way: a trailing newline doesn't add a line. 0 for the empty string
 * and for anything that isn't a string. The one counter classify, redact, filechanges and
 * shellwrites share, so the classifier's LoC, redacted dummies and file_changes all agree (#85).
 */
export function countLines(s: unknown): number {
  if (typeof s !== "string" || s.length === 0) return 0;
  const trimmed = s.endsWith("\n") ? s.slice(0, -1) : s;
  return trimmed.length === 0 ? 0 : trimmed.split("\n").length;
}
