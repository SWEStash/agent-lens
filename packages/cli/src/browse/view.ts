/**
 * The two screens of `agent-lens browse`, as pure functions from data to the exact lines to draw, and
 * the key handling as a reducer over a small state. The driver in index.ts only feeds them keys and
 * terminal sizes (ADR-042).
 */
import { basename } from "node:path";
import type { SessionDetail, SessionSummary, ToolCall } from "@agent-lens/contracts";
import { fmtUsd, fmtWhen } from "../report.js";
import { drawLine, severityStyle, type Line, type Span, type Style } from "./style.js";
import { clean, wrap } from "./text.js";

export interface ListState {
  screen: "list";
  cursor: number;
  top: number;
}
export interface PagerState {
  screen: "pager";
  top: number;
  /** The list to go back to, as it was left. */
  list: ListState;
}
export type State = ListState | PagerState;

export interface Key {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  shift?: boolean;
}

export type Effect = { type: "quit" } | { type: "open-pager" } | { type: "open-web" } | null;

/** How a key moves the state. `count` is the rows on the current screen (sessions or transcript
 * lines) and `height` the rows visible for them. */
export function reduce(state: State, key: Key, count: number, height: number): { state: State; effect: Effect } {
  const name = key.name ?? "";
  const seq = key.sequence ?? "";
  if (key.ctrl && name === "c") return { state, effect: { type: "quit" } };
  const page = Math.max(1, height - 1);

  if (state.screen === "list") {
    const move = (to: number): State => {
      const cursor = Math.max(0, Math.min(count - 1, to));
      const top = cursor < state.top ? cursor : cursor >= state.top + height ? cursor - height + 1 : state.top;
      return { ...state, cursor, top: Math.max(0, top) };
    };
    if (name === "q" || name === "escape") return { state, effect: { type: "quit" } };
    if (name === "return" || name === "right" || name === "l") return { state, effect: count ? { type: "open-pager" } : null };
    if (name === "o") return { state, effect: count ? { type: "open-web" } : null };
    if (name === "down" || name === "j") return { state: move(state.cursor + 1), effect: null };
    if (name === "up" || name === "k") return { state: move(state.cursor - 1), effect: null };
    if (name === "pagedown" || name === "space") return { state: move(state.cursor + page), effect: null };
    if (name === "pageup" || name === "b") return { state: move(state.cursor - page), effect: null };
    if (seq === "G" || name === "end") return { state: move(count - 1), effect: null };
    if (name === "g" || name === "home") return { state: move(0), effect: null };
    return { state, effect: null };
  }

  const last = Math.max(0, count - height);
  const scroll = (to: number): State => ({ ...state, top: Math.max(0, Math.min(last, to)) });
  if (name === "q" || name === "escape" || name === "left" || name === "h") return { state: state.list, effect: null };
  if (name === "o") return { state, effect: { type: "open-web" } };
  if (name === "down" || name === "j" || name === "return") return { state: scroll(state.top + 1), effect: null };
  if (name === "up" || name === "k") return { state: scroll(state.top - 1), effect: null };
  if (name === "pagedown" || name === "space") return { state: scroll(state.top + page), effect: null };
  if (name === "pageup" || name === "b") return { state: scroll(state.top - page), effect: null };
  if (seq === "G" || name === "end") return { state: scroll(last), effect: null };
  if (name === "g" || name === "home") return { state: scroll(0), effect: null };
  return { state, effect: null };
}

const pad = (s: string, w: number): string => (s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length));
const footer = (text: string, width: number, color: boolean): string => drawLine([[text, "dim"]], width, color);

/** One list row: when, a severity marker, title, project, cost. */
function listRow(x: SessionSummary, width: number): Line {
  const marker: Span = x.finding_count ? ["● ", severityStyle(x.worst_severity)] : ["  "];
  const project = pad(x.project_path ? basename(x.project_path) : "", 16);
  const cost = fmtUsd(x.cost).padStart(9);
  const titleW = Math.max(4, width - 16 - 2 - 2 - 2 - 16 - 2 - 9);
  const title = clean(x.title ?? x.id).replace(/\n/g, " ");
  const titleSpan = [...title].length > titleW ? [...title].slice(0, titleW - 1).join("") + "…" : pad(title, titleW);
  return [[fmtWhen(x.started_at).padEnd(16), "dim"], ["  "], marker, [titleSpan, "bold"], ["  "], [project, "project"], ["  "], [cost, "cost"]];
}

/** The list screen: a header, one row per visible session (the selected one inverted), and a footer
 * with the keys and any message. Exactly `height` lines of exactly `width` columns. */
export function renderList(sessions: SessionSummary[], s: ListState, width: number, height: number, message = "", color = false): string[] {
  const body = Math.max(1, height - 2);
  const lines = [drawLine([[`Sessions (${sessions.length})`, "title"], ["  ● has security findings", "dim"]], width, color)];
  for (let i = s.top; i < s.top + body; i++) {
    const x = sessions[i];
    if (!x) lines.push(" ".repeat(width));
    else lines.push(drawLine(listRow(x, width), width, color, i === s.cursor ? "7" : ""));
  }
  lines.push(footer(message || "↑↓ move · enter read · o open in web UI · q quit", width, color));
  return lines;
}

/** The pager screen: the session title, a window of its transcript, and a footer with the position. */
export function renderPager(title: string, transcript: Line[], s: PagerState, width: number, height: number, message = "", color = false): string[] {
  const body = Math.max(1, height - 2);
  const lines = [drawLine([[clean(title).replace(/\n/g, " "), "title"]], width, color)];
  for (let i = s.top; i < s.top + body; i++) lines.push(drawLine(transcript[i] ?? [], width, color));
  const end = Math.min(transcript.length, s.top + body);
  const pos = transcript.length ? `${s.top + 1}–${end} of ${transcript.length}` : "empty";
  lines.push(footer(message || `${pos} · ↑↓ space b scroll · o open in web UI · q back`, width, color));
  return lines;
}

/** A tool call as one line: its name, a failure mark, its worst finding, and what it acted on. */
export function toolLine(t: ToolCall): Line {
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(t.input_json ?? "{}") ?? {};
  } catch {
    /* not JSON: name only */
  }
  const what = ["command", "file_path", "notebook_path", "pattern", "url", "query", "skill", "description", "prompt"]
    .map((k) => input[k])
    .find((v): v is string => typeof v === "string" && v.length > 0);
  const name = t.skill_name ? `Skill ${t.skill_name}` : t.agent_type ? `${t.tool_name} → ${t.agent_type}` : t.tool_name;
  // The failure mark and the worst finding come before the input, so a long command is what gets cut.
  const line: Line = [["⏺ ", "tool"], [name, "toolName"]];
  if (t.status === "error") line.push([" (failed)", "error"]);
  const worst = t.findings?.[0];
  if (worst) line.push([` ● ${worst.severity} ${worst.rule_id}`, severityStyle(worst.severity)]);
  if (what) line.push([`: ${clean(what).split("\n")[0]}`, "tool"]);
  return line;
}

/** Message text as styled lines: headings bold, fenced code in the code colour, prose plain. */
function messageLines(text: string, width: number, indent: string): Line[] {
  const out: Line[] = [];
  let inCode = false;
  for (const raw of text.split("\n")) {
    const fence = /^\s*```/.test(raw);
    const style: Style = fence || inCode ? "code" : /^#{1,6}\s/.test(raw) ? "heading" : "plain";
    for (const l of wrap(raw, Math.max(10, width - indent.length))) out.push([[indent], [l, style]]);
    if (fence) inCode = !inCode;
  }
  return out;
}

/** A session's transcript as styled, wrapped lines: a short header, then each turn's messages and
 * tool calls, with each speaker labelled once per run. Thinking is left out, as the web UI
 * collapses it. */
export function transcriptLines(d: SessionDetail, width: number): Line[] {
  const s = d.session;
  const out: Line[] = [];
  const meta = `${fmtWhen(s.started_at)} · ${s.project_path ?? ""} · ${d.turns.length} turns · ${fmtUsd(s.cost)}`;
  for (const l of wrap(meta, width)) out.push([[l, "dim"]]);
  let turn: string | null = null;
  let n = 0;
  let speaker: string | null = null; // who the lines under the last label belong to
  for (const e of d.events) {
    if (e.turn_id && e.turn_id !== turn) {
      turn = e.turn_id;
      n++;
      speaker = null;
      out.push([], [[`── turn ${n} ${"─".repeat(Math.max(0, width - 12 - String(n).length))}`, "turn"]]);
    }
    const text = e.text ? clean(e.text).trim() : "";
    if (!text && !e.toolCalls.length) continue;
    const who = e.role === "user" ? "you" : e.role === "assistant" ? "claude" : e.type;
    if (who !== speaker) {
      out.push([], [[`${who}:`, who === "you" ? "you" : who === "claude" ? "claude" : "bold"]]);
      speaker = who;
    }
    if (text) out.push(...messageLines(text, width, "  "));
    for (const t of e.toolCalls) {
      const [first, ...rest] = toolLine(t);
      out.push([["  "], first, ...rest]);
    }
  }
  return out;
}
