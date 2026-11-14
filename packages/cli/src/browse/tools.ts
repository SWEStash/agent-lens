/**
 * Tool calls in the `agent-lens browse` transcript: one summary line when collapsed, and when
 * expanded the full input in the tool's own form (a Bash command, an edit's removed and added lines,
 * a file written) followed by its output. Pure, so it is tested without a terminal.
 */
import type { ToolCall } from "@agent-lens/contracts";
import { wrapSpans } from "./markdown.js";
import { severityStyle, type Line, type Span } from "./style.js";
import { clean } from "./text.js";

/** Output lines shown when a tool call is expanded; the web UI has the rest. */
export const MAX_OUTPUT_LINES = 300;

function inputOf(t: ToolCall): Record<string, unknown> {
  try {
    const v = JSON.parse(t.input_json ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** A tool call as one line: an expand marker, its name, markers (subagent, failure, worst finding),
 * and what it acted on last, so a long command is what gets cut. */
export function toolLine(t: ToolCall, expanded = false): Line {
  const input = inputOf(t);
  const what = ["command", "file_path", "notebook_path", "pattern", "url", "query", "skill", "description", "prompt"]
    .map((k) => str(input[k]))
    .find((v): v is string => v !== null);
  const name = t.skill_name ? `Skill ${t.skill_name}` : t.agent_type ? `${t.tool_name} → ${t.agent_type}` : t.tool_name;
  const line: Line = [[expanded ? "▾ " : "▸ ", "tool"], [name, "toolName"]];
  if (t.spawned_session_id) line.push([" [s]", "turn"]);
  if (t.status === "error") line.push([" (failed)", "error"]);
  const worst = t.findings?.[0];
  if (worst) line.push([` ● ${worst.severity} ${worst.rule_id}`, severityStyle(worst.severity)]);
  if (what) line.push([`: ${clean(what).split("\n")[0]}`, "tool"]);
  return line;
}

/** `text` as lines, each led by `lead` and wrapped to `width`. */
function block(text: string, lead: Span[], style: Span[1], width: number): Line[] {
  const leadW = lead.reduce((n, [s]) => n + s.length, 0);
  const out: Line[] = [];
  for (const raw of clean(text).split("\n")) {
    for (const l of wrapSpans([[raw, style]], width - leadW)) out.push([...lead, ...l]);
  }
  return out;
}

/** The full input of an expanded tool call, in the tool's own form. */
function inputLines(t: ToolCall, width: number): Line[] {
  const input = inputOf(t);
  const out: Line[] = [];
  const path = str(input.file_path) ?? str(input.notebook_path);
  if (t.tool_name === "Bash" && str(input.command)) {
    if (str(input.description)) out.push(...block(String(input.description), [["# ", "dim"]], "dim", width));
    out.push(...block(String(input.command), [["$ ", "toolName"]], "code", width));
    return out;
  }
  if (path) out.push(...block(path, [], "project", width));
  const edits =
    t.tool_name === "MultiEdit" && Array.isArray(input.edits)
      ? (input.edits as Array<Record<string, unknown>>)
      : str(input.old_string) !== null || str(input.new_string) !== null
        ? [input]
        : [];
  if (edits.length) {
    edits.forEach((e, i) => {
      if (i) out.push([["  ⋯", "dim"]]);
      if (str(e.old_string)) out.push(...block(String(e.old_string), [["- ", "removed"]], "removed", width));
      if (str(e.new_string)) out.push(...block(String(e.new_string), [["+ ", "added"]], "added", width));
    });
    return out;
  }
  if (str(input.content)) return [...out, ...block(String(input.content), [["+ ", "added"]], "added", width)];
  const rest = Object.fromEntries(Object.entries(input).filter(([k]) => k !== "file_path" && k !== "notebook_path"));
  if (Object.keys(rest).length) out.push(...block(JSON.stringify(rest, null, 2), [], "code", width));
  return out;
}

/** An expanded tool call's body: its input, then its output (the full spilled result when ingested,
 * else the stored summary), capped at MAX_OUTPUT_LINES. */
export function toolDetailLines(t: ToolCall, width: number): Line[] {
  const out = inputLines(t, width);
  const output = t.full_result?.text ?? t.result_summary;
  if (output) {
    const lines = block(output, [["│ ", t.status === "error" ? "error" : "dim"]], t.status === "error" ? "error" : "plain", width);
    out.push(...lines.slice(0, MAX_OUTPUT_LINES));
    if (lines.length > MAX_OUTPUT_LINES) out.push([[`│ … ${lines.length - MAX_OUTPUT_LINES} more lines; o opens the web UI`, "dim"]]);
  } else if (!out.length) {
    out.push([["(no input or output recorded)", "dim"]]);
  }
  return out;
}
