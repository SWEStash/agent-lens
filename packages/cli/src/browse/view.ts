/**
 * The two screens of `agent-lens browse`, as pure functions from data to the exact lines to draw, and
 * the key handling as a reducer over a small state. The driver in index.ts only feeds them keys and
 * terminal sizes (ADR-042).
 */
import { basename } from "node:path";
import type { SessionDetail, SessionSummary, ToolCall } from "@agent-lens/contracts";
import { fmtUsd, fmtWhen } from "../report.js";
import { clean, fit, wrap } from "./text.js";

const INVERSE = "\x1b[7m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

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

/** The list screen: a header, one row per visible session (the selected one inverted), and a footer
 * with the keys and any message. Exactly `height` lines of exactly `width` columns. */
export function renderList(sessions: SessionSummary[], s: ListState, width: number, height: number, message = ""): string[] {
  const body = Math.max(1, height - 2);
  const row = (x: SessionSummary) => {
    const when = fmtWhen(x.started_at).padEnd(16);
    const cost = fmtUsd(x.cost).padStart(9);
    const project = fit(x.project_path ? basename(x.project_path) : "", 16);
    const title = fit(clean(x.title ?? x.id).replace(/\n/g, " "), Math.max(4, width - 16 - 9 - 16 - 6));
    return fit(`${when}  ${title}  ${project}  ${cost}`, width);
  };
  const lines = [fit(`Sessions (${sessions.length})`, width)];
  for (let i = s.top; i < s.top + body; i++) {
    const x = sessions[i];
    if (!x) lines.push(" ".repeat(width));
    else lines.push(i === s.cursor ? INVERSE + row(x) + RESET : row(x));
  }
  lines.push(footer(message || "↑↓ move · enter read · o open in web UI · q quit", width));
  return lines;
}

/** The pager screen: the session title, a window of its transcript, and a footer with the position. */
export function renderPager(title: string, transcript: string[], s: PagerState, width: number, height: number, message = ""): string[] {
  const body = Math.max(1, height - 2);
  const lines = [fit(clean(title).replace(/\n/g, " "), width)];
  for (let i = s.top; i < s.top + body; i++) lines.push(fit(transcript[i] ?? "", width));
  const end = Math.min(transcript.length, s.top + body);
  const pos = transcript.length ? `${s.top + 1}–${end} of ${transcript.length}` : "empty";
  lines.push(footer(message || `${pos} · ↑↓ space b scroll · o open in web UI · q back`, width));
  return lines;
}

const footer = (text: string, width: number): string => DIM + fit(text, width) + RESET;

/** One line naming a tool call and what it acted on: `Bash: pnpm test`, `Edit: src/a.ts`. */
export function toolLine(t: ToolCall): string {
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
  const failed = t.status === "error" ? " (failed)" : "";
  return `⏺ ${name}${what ? `: ${clean(what).split("\n")[0]}` : ""}${failed}`;
}

/** A session's transcript as wrapped lines: a short header, then each turn's messages and tool calls.
 * Thinking is left out, as the web UI collapses it. */
export function transcriptLines(d: SessionDetail, width: number): string[] {
  const s = d.session;
  const out: string[] = [];
  const add = (text: string, indent = "") => {
    for (const l of wrap(text, Math.max(10, width - indent.length))) out.push(indent + l);
  };
  add(`${fmtWhen(s.started_at)} · ${s.project_path ?? ""} · ${d.turns.length} turns · ${fmtUsd(s.cost)}`);
  let turn: string | null = null;
  let n = 0;
  let speaker: string | null = null; // who the lines under the last header belong to
  for (const e of d.events) {
    if (e.turn_id && e.turn_id !== turn) {
      turn = e.turn_id;
      n++;
      speaker = null;
      out.push("", `── turn ${n} ${"─".repeat(Math.max(0, width - 12 - String(n).length))}`);
    }
    const text = e.text ? clean(e.text).trim() : "";
    if (!text && !e.toolCalls.length) continue;
    const who = e.role === "user" ? "you" : e.role === "assistant" ? "claude" : e.type;
    if (who !== speaker) {
      out.push("", `${who}:`);
      speaker = who;
    }
    if (text) add(text, "  ");
    for (const t of e.toolCalls) add(toolLine(t), "  ");
  }
  return out;
}
