/**
 * The screens of `agent-lens browse`, as pure functions from data to the exact lines to draw, and the
 * key handling as a reducer over a small state. The driver in index.ts only feeds them keys and
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
  /** Narrows the list to sessions whose title, project or id contains it. */
  filter: string;
  /** Text being typed after `/`; the filter follows it live. */
  prompt?: string;
  help?: boolean;
}
export interface PagerState {
  screen: "pager";
  sessionId: string;
  top: number;
  /** The list to go back to, as it was left. */
  list: ListState;
  /** The transcript this subagent's was opened from; `q` returns there instead of the list. */
  parent?: PagerState;
  find: string;
  prompt?: string;
  thinking: boolean;
  results: boolean;
  help?: boolean;
}
export type State = ListState | PagerState;

export interface Key {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export type Effect =
  | { type: "quit" }
  | { type: "open-pager" }
  | { type: "open-web" }
  | { type: "open-subagent" }
  | { type: "copy" }
  | { type: "message"; text: string }
  | null;

/** What the reducer needs to know about the screen: how many rows it has (sessions or transcript
 * lines), how many are visible, and for a transcript its plain text and where each turn starts. */
export interface Ctx {
  count: number;
  height: number;
  texts?: string[];
  turns?: number[];
}

/** The next line at or after `from` (or before it, going back) that contains `query`, any case. */
export function findLine(texts: string[], query: string, from: number, dir: 1 | -1): number | null {
  const q = query.toLowerCase();
  if (!q) return null;
  for (let i = from; i >= 0 && i < texts.length; i += dir) if (texts[i].toLowerCase().includes(q)) return i;
  return null;
}

/** The sessions whose title, project path or id contains `filter`, any case. */
export function filterSessions(all: SessionSummary[], filter: string): SessionSummary[] {
  const q = filter.trim().toLowerCase();
  if (!q) return all;
  return all.filter((s) => [s.title, s.project_path, s.id].some((v) => v?.toLowerCase().includes(q)));
}

const printable = (key: Key): string | null => {
  const seq = key.sequence ?? "";
  return !key.ctrl && !key.meta && seq && !/[\u0000-\u001f\u007f]/.test(seq) ? seq : null;
};

/** How a key moves the state. */
export function reduce(state: State, key: Key, ctx: Ctx): { state: State; effect: Effect } {
  const name = key.name ?? "";
  const seq = key.sequence ?? "";
  const none = (s: State = state) => ({ state: s, effect: null as Effect });
  if (key.ctrl && name === "c") return { state, effect: { type: "quit" } };
  if (state.help) return none({ ...state, help: false });

  if (state.prompt !== undefined) return typing(state, key, ctx);

  if (seq === "?") return none({ ...state, help: true });
  if (seq === "y") return { state, effect: { type: "copy" } };
  if (seq === "/") return none({ ...state, prompt: state.screen === "list" ? state.filter : "" });
  const page = Math.max(1, ctx.height - 1);

  if (state.screen === "list") {
    const move = (to: number): State => {
      const cursor = Math.max(0, Math.min(ctx.count - 1, to));
      const top = cursor < state.top ? cursor : cursor >= state.top + ctx.height ? cursor - ctx.height + 1 : state.top;
      return { ...state, cursor, top: Math.max(0, top) };
    };
    if (name === "escape" && state.filter) return none({ ...state, filter: "", cursor: 0, top: 0 });
    if (name === "q" || name === "escape") return { state, effect: { type: "quit" } };
    if (name === "return" || name === "right" || name === "l") return { state, effect: ctx.count ? { type: "open-pager" } : null };
    if (name === "o") return { state, effect: ctx.count ? { type: "open-web" } : null };
    if (name === "down" || name === "j") return none(move(state.cursor + 1));
    if (name === "up" || name === "k") return none(move(state.cursor - 1));
    if (name === "pagedown" || name === "space") return none(move(state.cursor + page));
    if (name === "pageup" || name === "b") return none(move(state.cursor - page));
    if (seq === "G" || name === "end") return none(move(ctx.count - 1));
    if (name === "g" || name === "home") return none(move(0));
    return none();
  }

  const last = Math.max(0, ctx.count - ctx.height);
  const scroll = (to: number): State => ({ ...state, top: Math.max(0, Math.min(last, to)) });
  const texts = ctx.texts ?? [];
  if (name === "escape" && state.find) return none({ ...state, find: "" });
  if (name === "q" || name === "escape" || name === "left" || name === "h") return none(state.parent ?? state.list);
  if (name === "o") return { state, effect: { type: "open-web" } };
  if (name === "s") return { state, effect: { type: "open-subagent" } };
  if (name === "t") return none({ ...state, thinking: !state.thinking });
  if (name === "r") return none({ ...state, results: !state.results });
  if (seq === "n" || seq === "N") {
    if (!state.find) return { state, effect: { type: "message", text: "Press / to find text first" } };
    const hit = seq === "n" ? findLine(texts, state.find, state.top + 1, 1) : findLine(texts, state.find, state.top - 1, -1);
    if (hit === null) return { state, effect: { type: "message", text: `No more matches for "${state.find}"` } };
    // The match goes on the top line even near the end (blank lines below, as `less` does), so the
    // next `n` searches from past it instead of finding it again.
    return none({ ...state, top: hit });
  }
  if (seq === "]" || seq === "[") {
    const turns = ctx.turns ?? [];
    const next = seq === "]" ? turns.find((t) => t > state.top) : [...turns].reverse().find((t) => t < state.top);
    return next === undefined ? none() : none({ ...state, top: next });
  }
  if (name === "down" || name === "j" || name === "return") return none(scroll(state.top + 1));
  if (name === "up" || name === "k") return none(scroll(state.top - 1));
  if (name === "pagedown" || name === "space") return none(scroll(state.top + page));
  if (name === "pageup" || name === "b") return none(scroll(state.top - page));
  if (seq === "G" || name === "end") return none(scroll(last));
  if (name === "g" || name === "home") return none(scroll(0));
  return none();
}

/** Keys while typing after `/`: text, backspace, enter to keep, escape to drop. On the list the
 * filter follows the text as it is typed; in a transcript enter jumps to the first match. */
function typing(state: State, key: Key, ctx: Ctx): { state: State; effect: Effect } {
  const text = state.prompt ?? "";
  const set = (t: string): State =>
    state.screen === "list" ? { ...state, prompt: t, filter: t, cursor: 0, top: 0 } : { ...state, prompt: t };
  if (key.name === "escape") {
    return { state: state.screen === "list" ? { ...state, prompt: undefined, filter: "", cursor: 0, top: 0 } : { ...state, prompt: undefined }, effect: null };
  }
  if (key.name === "return") {
    if (state.screen === "list") return { state: { ...state, prompt: undefined }, effect: null };
    const hit = findLine(ctx.texts ?? [], text, state.top, 1) ?? findLine(ctx.texts ?? [], text, 0, 1);
    const next: PagerState = { ...state, prompt: undefined, find: text };
    if (!text) return { state: next, effect: null };
    if (hit === null) return { state: next, effect: { type: "message", text: `No match for "${text}"` } };
    return { state: { ...next, top: hit }, effect: null };
  }
  if (key.name === "backspace") return { state: set(text.slice(0, -1)), effect: null };
  const ch = printable(key);
  return { state: ch ? set(text + ch) : state, effect: null };
}

const pad = (s: string, w: number): string => (s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length));
const footer = (text: string, width: number, color: boolean): string => drawLine([[text, "dim"]], width, color);
const promptLine = (text: string, hint: string, width: number, color: boolean): string =>
  drawLine([["/", "bold"], [text], ["█", "dim"], [`   ${hint}`, "dim"]], width, color);

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
 * with the keys, the filter being typed, or a message. Exactly `height` lines of `width` columns.
 * `sessions` is the filtered list; `total` how many there are before the filter. */
export function renderList(
  sessions: SessionSummary[],
  s: ListState,
  width: number,
  height: number,
  message = "",
  color = false,
  total = sessions.length,
): string[] {
  if (s.help) return renderHelp("list", width, height, color);
  const body = Math.max(1, height - 2);
  const count = s.filter ? `${sessions.length} of ${total}` : String(total);
  const head: Line = [[`Sessions (${count})`, "title"]];
  if (s.filter && s.prompt === undefined) head.push([`  filter: ${s.filter}`, "turn"]);
  head.push(["  ● has security findings", "dim"]);
  const lines = [drawLine(head, width, color)];
  for (let i = s.top; i < s.top + body; i++) {
    const x = sessions[i];
    if (!x) lines.push(" ".repeat(width));
    else lines.push(drawLine(listRow(x, width), width, color, i === s.cursor ? "7" : ""));
  }
  if (s.prompt !== undefined) lines.push(promptLine(s.prompt, "enter keep · esc clear", width, color));
  else lines.push(footer(message || "↑↓ move · enter read · / filter · o web UI · y copy id · ? help · q quit", width, color));
  return lines;
}

/** `line` with every occurrence of `query` (any case) drawn inverted. */
export function highlight(line: Line, query: string): Line {
  const q = query.toLowerCase();
  if (!q) return line;
  const out: Line = [];
  for (const [text, style] of line) {
    const lower = text.toLowerCase();
    let at = 0;
    for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, at)) {
      if (i > at) out.push([text.slice(at, i), style]);
      out.push([text.slice(i, i + q.length), "match"]);
      at = i + q.length;
    }
    if (at < text.length) out.push([text.slice(at), style]);
  }
  return out;
}

/** The pager screen: the session title, a window of its transcript (find matches inverted), and a
 * footer with the position, the find being typed, or a message. */
export function renderPager(
  title: string,
  transcript: Line[],
  s: PagerState,
  width: number,
  height: number,
  message = "",
  color = false,
): string[] {
  if (s.help) return renderHelp("pager", width, height, color);
  const body = Math.max(1, height - 2);
  const lines = [drawLine([[clean(title).replace(/\n/g, " "), "title"]], width, color)];
  for (let i = s.top; i < s.top + body; i++) lines.push(drawLine(highlight(transcript[i] ?? [], s.find), width, color));
  const end = Math.min(transcript.length, s.top + body);
  const pos = transcript.length ? `${s.top + 1}–${end} of ${transcript.length}` : "empty";
  const shown = [s.thinking && "thinking", s.results && "results"].filter(Boolean).join(", ");
  if (s.prompt !== undefined) lines.push(promptLine(s.prompt, "enter find · esc cancel", width, color));
  else if (message) lines.push(footer(message, width, color));
  else if (s.find) lines.push(footer(`${pos} · "${s.find}": n next · N previous · esc clear`, width, color));
  else lines.push(footer(`${pos}${shown ? ` · showing ${shown}` : ""} · [ ] turns · / find · ? help · q back`, width, color));
  return lines;
}

const HELP: Record<"list" | "pager", Array<[string, string]>> = {
  list: [
    ["↑ ↓  j k", "move"],
    ["space b  PgDn PgUp", "page"],
    ["g G  Home End", "first, last"],
    ["enter  →", "read the transcript"],
    ["/", "filter by title, project or id (esc clears)"],
    ["o", "open in the web UI (needs agent-lens serve)"],
    ["y", "copy the session id"],
    ["q  esc", "quit"],
  ],
  pager: [
    ["↑ ↓  j k", "scroll"],
    ["space b  PgDn PgUp", "page"],
    ["g G  Home End", "top, bottom"],
    ["[ ]", "previous, next turn"],
    ["/  n N", "find text, next, previous (esc clears)"],
    ["t", "show or hide thinking"],
    ["r", "show or hide tool results"],
    ["s", "open the subagent of the first [s] call on screen"],
    ["o", "open in the web UI (needs agent-lens serve)"],
    ["y", "copy the session id"],
    ["q  esc  ←", "back"],
  ],
};

/** The key list for a screen; any key closes it. */
export function renderHelp(screen: "list" | "pager", width: number, height: number, color: boolean): string[] {
  const lines = [drawLine([["Keys", "title"]], width, color), " ".repeat(width)];
  for (const [keys, what] of HELP[screen]) lines.push(drawLine([[`  ${keys.padEnd(22)}`, "toolName"], [what]], width, color));
  while (lines.length < height - 1) lines.push(" ".repeat(width));
  lines.length = Math.max(1, height - 1);
  lines.push(footer("any key closes", width, color));
  return lines;
}

/** A tool call as one line: its name, markers (subagent, failure, worst finding), and what it acted
 * on last, so a long command is what gets cut. */
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
  const line: Line = [["⏺ ", "tool"], [name, "toolName"]];
  if (t.spawned_session_id) line.push([" [s]", "turn"]);
  if (t.status === "error") line.push([" (failed)", "error"]);
  const worst = t.findings?.[0];
  if (worst) line.push([` ● ${worst.severity} ${worst.rule_id}`, severityStyle(worst.severity)]);
  if (what) line.push([`: ${clean(what).split("\n")[0]}`, "tool"]);
  return line;
}

/** Message text as styled lines: headings bold, fenced code in the code colour, prose in `prose`. */
function messageLines(text: string, width: number, indent: string, prose: Style = "plain"): Line[] {
  const out: Line[] = [];
  let inCode = false;
  for (const raw of text.split("\n")) {
    const fence = /^\s*```/.test(raw);
    const style: Style = fence || inCode ? "code" : /^#{1,6}\s/.test(raw) ? "heading" : prose;
    for (const l of wrap(raw, Math.max(10, width - indent.length))) out.push([[indent], [l, style]]);
    if (fence) inCode = !inCode;
  }
  return out;
}

export interface Transcript {
  lines: Line[];
  /** The line each turn's rule is on, in order. */
  turns: number[];
  /** Tool calls that spawned a subagent: the line they are on and the subagent's session id. */
  subagents: Array<{ line: number; sessionId: string }>;
}

/**
 * A session's transcript as styled, wrapped lines: a short header, then each turn's messages and
 * tool calls, with each speaker labelled once per run. Thinking and tool results are left out, as
 * the web UI collapses them, unless asked for.
 */
export function transcriptLines(d: SessionDetail, width: number, show: { thinking?: boolean; results?: boolean } = {}): Transcript {
  const s = d.session;
  const out: Line[] = [];
  const turns: number[] = [];
  const subagents: Transcript["subagents"] = [];
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
      out.push([]);
      turns.push(out.length);
      out.push([[`── turn ${n} ${"─".repeat(Math.max(0, width - 12 - String(n).length))}`, "turn"]]);
    }
    const text = e.text ? clean(e.text).trim() : "";
    const thinking = show.thinking && e.thinking ? clean(e.thinking).trim() : "";
    if (!text && !thinking && !e.toolCalls.length) continue;
    const who = e.role === "user" ? "you" : e.role === "assistant" ? "claude" : e.type;
    if (who !== speaker) {
      out.push([], [[`${who}:`, who === "you" ? "you" : who === "claude" ? "claude" : "bold"]]);
      speaker = who;
    }
    if (thinking) out.push([["  "], ["thinking", "thinking"]], ...messageLines(thinking, width, "  │ ", "thinking"));
    if (text) out.push(...messageLines(text, width, "  "));
    for (const t of e.toolCalls) {
      if (t.spawned_session_id) subagents.push({ line: out.length, sessionId: t.spawned_session_id });
      out.push([["  "], ...toolLine(t)]);
      if (show.results && t.result_summary) {
        for (const l of wrap(clean(t.result_summary), Math.max(10, width - 6))) out.push([["    │ ", "tool"], [l, "dim"]]);
      }
    }
  }
  return { lines: out, turns, subagents };
}
