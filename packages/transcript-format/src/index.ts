/**
 * @agent-lens/transcript-format — the markup vocabulary Claude Code embeds inside message text.
 *
 * Claude Code wraps some content in XML-ish tags inside an otherwise ordinary user message: slash
 * commands and their local output (`<command-name>`, `<local-command-stdout>`, …) and async-task
 * completions (`<task-notification>`). Three packages need to recognize that markup — ingest, to tell
 * a command's output from a prompt when grouping turns; the server, to read a workflow's completion;
 * and web, to render commands and notifications as cards rather than raw tags. Before this package
 * each kept its own copy, and the server's and web's tag readers were the same regex character for
 * character.
 *
 * **Scope:** this is *surface vocabulary* — the tag names and how to read one — not transcript
 * parsing. How a transcript record is shaped (where text, reasoning, or a queued prompt live) stays
 * behind the `SourceAdapter` seam in `packages/ingest/src/adapters/`, per ADR-008. The distinction
 * matters: adapters own the record; this owns strings that appear *within* message text and that a
 * browser has to re-recognize at render time.
 *
 * **Constraints:** zero dependencies and no `node:` imports, so the browser bundle can import it.
 * `@agent-lens/contracts` deliberately cannot host this — it is a pure-types leaf whose node-free
 * guarantee is structural precisely because it exports no values.
 *
 * It is named for Claude Code on purpose. A second agent would bring its own vocabulary rather than
 * inherit this one.
 */

/** Tags naming a slash-command invocation the user typed. */
export const COMMAND_NAME_TAG = "command-name";
export const COMMAND_MESSAGE_TAG = "command-message";
export const COMMAND_ARGS_TAG = "command-args";

/** The banner Claude Code prepends to a local slash command's transcript block. */
export const COMMAND_CAVEAT_TAG = "local-command-caveat";

/**
 * Tags carrying a slash command's *output*. These ride on a `user` line but are a result, not
 * something the user typed — treating one as a prompt opens a spurious turn (`/login` writes its
 * command and its stdout with the same timestamp, so they are otherwise hard to tell apart).
 */
export const COMMAND_OUTPUT_TAGS = ["local-command-stdout", "local-command-stderr", "command-output"] as const;

/** Tags inside a `<task-notification>` block, posted when an async Workflow or Agent run finishes. */
export const TASK_NOTIFICATION_TAG = "task-notification";
export const TASK_ID_TAG = "task-id";
export const TASK_TOOL_USE_ID_TAG = "tool-use-id";
export const TASK_STATUS_TAG = "status";
export const TASK_SUMMARY_TAG = "summary";
export const TASK_RESULT_TAG = "result";
export const TASK_FAILURES_TAG = "failures";

const COMMAND_OUTPUT_ALTERNATION = COMMAND_OUTPUT_TAGS.join("|");

/** Matches a message whose body *starts* with a command-output tag — i.e. the whole line is a result. */
const COMMAND_RESULT_CARRIER = new RegExp(`^<(?:${COMMAND_OUTPUT_ALTERNATION})>`);

/**
 * True when this message text is a slash command's output rather than a prompt. Anchored at the
 * start so a message that merely *quotes* a tag isn't mistaken for one; a `<command-name>` line is
 * the genuine prompt and is never matched here.
 */
export function isCommandResultCarrier(text: string): boolean {
  return COMMAND_RESULT_CARRIER.test(text.trimStart());
}

/** Read one tag's inner content, trimmed, or null when the tag is absent. Non-greedy, so the first
 * `</tag>` closes it, and dot-all via `[\s\S]` so multi-line bodies (a command's stdout, a task
 * summary) are captured whole. */
export function xmlTag(text: string, tag: string): string | null {
  return text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? null;
}

/** Read the first of the command-output tags present, or null when none is. */
export function commandOutput(text: string): string | null {
  return text.match(new RegExp(`<(?:${COMMAND_OUTPUT_ALTERNATION})>([\\s\\S]*?)</(?:${COMMAND_OUTPUT_ALTERNATION})>`))?.[1]?.trim() ?? null;
}
