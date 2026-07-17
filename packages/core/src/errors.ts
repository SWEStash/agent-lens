/**
 * Agent Lens — tool-error classification. No AI: an errored tool call is bucketed deterministically
 * by pattern-matching its verbatim `result_summary`. Re-runnable and idempotent — the same text always
 * yields the same bucket. `ERROR_CLASSIFIER_VERSION` lets a future engine supersede prior labels.
 *
 * ── The authority boundary (why this is careful) ────────────────────────────────────────────────
 * The Messages API's tool_result carries a single boolean `is_error` and **no field for *why*** a
 * result is an error — the API does not distinguish a tool that genuinely failed from one the user or
 * a permission/guardrail system rejected (see platform.claude.com tool-use docs). Claude Code sets
 * `is_error: true` for *both* real failures and permission denials / guardrail blocks; the only signal
 * of which is the human-readable result text (see code.claude.com/docs/en/errors + the auto-mode post).
 *
 * Therefore: the raw `is_error` / `tool_calls.status='error'` **count** is the authoritative, documented
 * signal. The `type` bucket and the failure-vs-rejection `kind` below are a **heuristic over Claude
 * Code's result wording** — best-effort, and liable to drift if that wording changes. Surface them as
 * such (not as an API-blessed fact), and bump ERROR_CLASSIFIER_VERSION when the patterns change.
 */

// Bump on any pattern/bucket change so a reclassification is attributable to an engine version
// (mirrors CLASSIFIER_VERSION / DETECTOR_VERSION).
export const ERROR_CLASSIFIER_VERSION = 1;

/** The error bucket. `other` = errored but unmatched by the patterns below. */
export type ToolErrorType =
  | "string-not-found" // Edit: the old_string wasn't found in the file
  | "command-failed" // Bash: non-zero exit code
  | "file-state" // Read/Write/Edit: file missing / not-read-first / changed-since-read / is-a-directory
  | "token-limit" // Read: file content exceeds the tool's token cap
  | "user-rejected" // the human declined / interrupted / cancelled the tool use
  | "guardrail-blocked" // Claude Code's own guardrail blocked the command
  | "other";

/**
 * Whether the error reflects the agent's tool genuinely failing (`failure`) or a human/harness
 * declining to run it (`rejection`). Rejections are NOT agent failures — separating them keeps the
 * "how often did the agent's tools fail" signal honest.
 */
export type ToolErrorKind = "failure" | "rejection";

export interface ToolErrorClass {
  type: ToolErrorType;
  kind: ToolErrorKind;
}

/** Error types that represent a human/harness declining the tool use — NOT the agent's tool failing. */
export const REJECTION_TYPES: ReadonlySet<ToolErrorType> = new Set<ToolErrorType>(["user-rejected", "guardrail-blocked"]);

/** The kind (failure vs rejection) implied by an error type — the single mapping used everywhere. */
export function errorKind(type: ToolErrorType): ToolErrorKind {
  return REJECTION_TYPES.has(type) ? "rejection" : "failure";
}

// Ordered most-specific → fallback; first match wins. Rejection patterns are checked first because a
// rejection message can also mention a command that would otherwise look like a real failure.
const PATTERNS: Array<{ re: RegExp; type: ToolErrorType; kind: ToolErrorKind }> = [
  // — Rejections / blocks: is_error, but the agent's tool didn't fail — a human or guardrail stopped it.
  { re: /interrupted by user|tool use was rejected|does(?:n['’]| not)t want to proceed|\bCancelled:/i, type: "user-rejected", kind: "rejection" },
  { re: /\bBlocked:/i, type: "guardrail-blocked", kind: "rejection" },
  // — Real tool failures.
  { re: /String to replace not found/i, type: "string-not-found", kind: "failure" },
  { re: /exceeds maximum allowed tokens/i, type: "token-limit", kind: "failure" },
  // A non-zero Bash exit code is a command failure regardless of what its stderr text mentions — check
  // it before the file-state fs-error patterns, since ENOENT/EISDIR also appear inside command stderr
  // (e.g. `Exit code 2 npm error ENOENT`). The file-state patterns then catch the Read/Write/Edit
  // tool_use_errors, which carry no exit code.
  { re: /\bExit code\b/i, type: "command-failed", kind: "failure" },
  { re: /has not been read yet|modified since (?:you |it was )?read|File (?:content )?does not exist|\bEISDIR\b|\bENOENT\b/i, type: "file-state", kind: "failure" },
];

/**
 * Classify an errored tool call from its `result_summary` text. Only call this on tool calls already
 * known to be errors (`status='error'` / `is_error: true`) — it always returns a class, defaulting to
 * `{ type: "other", kind: "failure" }` for an errored result whose text matches no pattern.
 */
export function classifyToolError(resultSummary: string | null | undefined): ToolErrorClass {
  const s = resultSummary ?? "";
  for (const p of PATTERNS) {
    if (p.re.test(s)) return { type: p.type, kind: p.kind };
  }
  return { type: "other", kind: "failure" };
}
