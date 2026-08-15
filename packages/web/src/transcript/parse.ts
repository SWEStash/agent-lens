/** Parsers for the JSON/markup payloads the transcript renders — tool inputs, tool results, and the
 * `<command-*>` / `<task-notification>` markup Claude Code embeds in user messages. Every parser is
 * total: malformed input returns null/empty so the caller falls back to the generic chip, never throws.
 * Pure, no JSX — see parse.test.ts.
 *
 * The tag names and the tag reader come from `@agent-lens/transcript-format`, shared with ingest and
 * the server (ADR-031); what stays here is the render-side shaping those three don't need. */
import {
  COMMAND_ARGS_TAG,
  COMMAND_CAVEAT_TAG,
  COMMAND_NAME_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TASK_STATUS_TAG,
  TASK_SUMMARY_TAG,
  TASK_TOOL_USE_ID_TAG,
  commandOutput,
  xmlTag,
} from "@agent-lens/transcript-format";
import { diffLines, type DiffLine } from "./diff";

/** Pull the plan markdown out of an ExitPlanMode call's input. Real approvals carry the full plan in
 * `input.plan`; the plan-file workflow variant sends `{}` (plan lives in a file) → null, and we fall
 * back to the generic chip. */
export function parsePlan(inputJson: string | null): string | null {
  if (!inputJson) return null;
  try {
    const plan = JSON.parse(inputJson).plan;
    return typeof plan === "string" && plan.trim() ? plan : null;
  } catch {
    return null;
  }
}

export interface AUQOption {
  label: string;
  description?: string;
}
export interface AUQQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AUQOption[];
}

export function parseQuestions(inputJson: string | null): AUQQuestion[] {
  if (!inputJson) return [];
  try {
    const q = JSON.parse(inputJson).questions;
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}

/** Answers/notes for an AskUserQuestion, both keyed by question text. Present only for sessions ingested
 * after answer-capture landed; older rows have a prose summary that won't parse → empty (questions and
 * options still render, just without the selection marked). */
export function parseAnswers(resultSummary: string | null): {
  answers: Record<string, string | string[]>;
  annotations: Record<string, { notes?: string }>;
} {
  if (!resultSummary) return { answers: {}, annotations: {} };
  try {
    const o = JSON.parse(resultSummary);
    if (o && typeof o === "object" && o.answers) return { answers: o.answers, annotations: o.annotations ?? {} };
  } catch {
    /* pre-capture prose summary — no structured answers */
  }
  return { answers: {}, annotations: {} };
}

export interface BashInput {
  command: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
  restart?: boolean;
}

/** Pull the shell command (+ optional description/flags) out of a Bash tool call's input so it can be
 * rendered like a terminal instead of a raw JSON blob. Only `command` is guaranteed; the rest are
 * optional/version-dependent (surfaced as badges, with the raw JSON as the source of truth). Returns
 * null when there's no usable command (malformed/empty input) → caller falls back to the generic chip. */
export function parseBashInput(inputJson: string | null): BashInput | null {
  if (!inputJson) return null;
  try {
    const o = JSON.parse(inputJson);
    if (!o || typeof o !== "object") return null;
    const command = typeof o.command === "string" ? o.command : "";
    if (!command.trim()) return null;
    return {
      command,
      description: typeof o.description === "string" ? o.description : undefined,
      timeout: typeof o.timeout === "number" ? o.timeout : undefined,
      run_in_background: o.run_in_background === true,
      restart: o.restart === true,
    };
  } catch {
    return null;
  }
}

export interface EditView {
  file_path: string;
  kind: "Edit" | "MultiEdit" | "Write";
  hunks: DiffLine[][];
  adds: number;
  dels: number;
}

/** Normalize an Edit / MultiEdit / Write tool input into diff hunks: Edit → one hunk (old→new),
 * MultiEdit → one hunk per edit, Write → one all-additions hunk (new file content). Returns null when
 * the input lacks a file path / usable payload, so the caller falls back to the generic chip. */
export function parseEditInput(toolName: string, inputJson: string | null): EditView | null {
  if (!inputJson) return null;
  try {
    const o = JSON.parse(inputJson);
    if (!o || typeof o !== "object" || typeof o.file_path !== "string") return null;
    let hunks: DiffLine[][];
    if (toolName === "Write") {
      if (typeof o.content !== "string") return null;
      hunks = [o.content === "" ? [] : o.content.split("\n").map((text: string) => ({ type: "add" as const, text }))];
    } else if (toolName === "MultiEdit") {
      if (!Array.isArray(o.edits)) return null;
      hunks = o.edits
        .filter((e: unknown): e is { old_string: string; new_string: string } => {
          const r = e as Record<string, unknown>;
          return !!r && typeof r.old_string === "string" && typeof r.new_string === "string";
        })
        .map((e: { old_string: string; new_string: string }) => diffLines(e.old_string, e.new_string));
      if (hunks.length === 0) return null;
    } else {
      if (typeof o.old_string !== "string" || typeof o.new_string !== "string") return null;
      hunks = [diffLines(o.old_string, o.new_string)];
    }
    let adds = 0;
    let dels = 0;
    for (const h of hunks)
      for (const l of h) {
        if (l.type === "add") adds++;
        else if (l.type === "del") dels++;
      }
    return { file_path: o.file_path, kind: toolName as EditView["kind"], hunks, adds, dels };
  } catch {
    return null;
  }
}

/** Split a file path into a directory prefix and basename for the header (basename emphasized). */
export function splitPath(p: string): { dir: string; base: string } {
  const i = p.lastIndexOf("/");
  return i >= 0 ? { dir: p.slice(0, i + 1), base: p.slice(i + 1) } : { dir: "", base: p };
}

/** Claude Code wraps slash-command invocations and their local output in markup tags inside a
 * user message (e.g. `<command-name>/plugin</command-name>`, `<local-command-stdout>…`). Rendered
 * verbatim that looks like noise, so we detect and render it as a distinct command element. */
export type ParsedCommand =
  | { kind: "invocation"; name: string; args: string }
  | { kind: "output"; stdout: string }
  | { kind: "caveat" };

export function parseCommand(text: string): ParsedCommand | null {
  const name = xmlTag(text, COMMAND_NAME_TAG);
  if (name) {
    const args = xmlTag(text, COMMAND_ARGS_TAG) ?? "";
    return { kind: "invocation", name: name.startsWith("/") ? name : `/${name}`, args };
  }
  const out = commandOutput(text);
  if (out != null) return { kind: "output", stdout: out };
  if (text.includes(`<${COMMAND_CAVEAT_TAG}>`)) return { kind: "caveat" };
  return null;
}

/** Claude Code posts a `<task-notification>` user message when an async task (Workflow run, or a
 * backgrounded Agent) finishes. Rendered verbatim it's a wall of XML; we parse the inner tags so it
 * can show as a compact status card that links back to the workflow it reports on. */
export interface ParsedTaskNotification {
  taskId: string | null;
  toolUseId: string | null;
  status: string | null;
  summary: string | null;
}

export function parseTaskNotification(text: string): ParsedTaskNotification | null {
  if (!text.includes(`<${TASK_NOTIFICATION_TAG}>`)) return null;
  return {
    taskId: xmlTag(text, TASK_ID_TAG),
    toolUseId: xmlTag(text, TASK_TOOL_USE_ID_TAG),
    status: xmlTag(text, TASK_STATUS_TAG),
    summary: xmlTag(text, TASK_SUMMARY_TAG),
  };
}

/** A turn's prompt preview, with slash-command markup collapsed to a readable label so the turn
 * header doesn't show raw `<command-name>…` tags. */
export function previewLabel(text: string): string {
  const cmd = parseCommand(text);
  if (cmd?.kind === "invocation") return `⌘ ${cmd.name}${cmd.args ? " " + cmd.args : ""}`;
  if (cmd?.kind === "output") return "⌘ command output";
  if (cmd?.kind === "caveat") return "⌘ local command";
  const notif = parseTaskNotification(text);
  if (notif) return `🔔 task ${notif.status ?? "notification"}`;
  return text;
}
