/**
 * The screens of `agent-lens browse`, as pure functions from data to the exact lines to draw, and the
 * key handling as a reducer over a small state. The driver in index.ts only feeds them keys and
 * terminal sizes (ADR-042).
 *
 * A transcript is a list of items (each message, thinking block and tool call) with the lines they
 * occupy. The pager keeps one item selected; `↑`/`↓` move between items and `Enter` expands one.
 */
import { basename } from "node:path";
import type { SessionDetail, SessionSummary } from "@agent-lens/contracts";
import { fmtUsd, fmtWhen } from "../report.js";
import { markdownLines } from "./markdown.js";
import { drawLine, SELECTED_BG, severityStyle, type Line, type Span, type Style, type Theme } from "./style.js";
import { clean, wrap } from "./text.js";
import { toolDetailLines, toolLine } from "./tools.js";

export type SortColumn = "started" | "title" | "source" | "project" | "turns";
export const SORT_COLUMNS: readonly SortColumn[] = ["started", "title", "source", "project", "turns"];

export interface ListState {
  screen: "list";
  cursor: number;
  top: number;
  /** Narrows the loaded list to sessions whose title, project or id contains it, as it is typed. */
  filter: string;
  /** Text being typed after `/`; the filter follows it live, and enter searches transcripts for it. */
  prompt?: string;
  /** A full-text search over names, projects and transcripts, run by the store's query. */
  search?: string;
  /** Source and project ids the store's query filters by. */
  source?: string;
  project?: string;
  sort: { column: SortColumn; desc: boolean };
  /** The source and project picker, open over the list. */
  picker?: { cursor: number; top: number };
  help?: boolean;
}

/** An entry in the source and project picker; `value` null means "all". */
export interface PickerOption {
  group: "source" | "project";
  value: string | null;
  label: string;
  count?: number;
}
export interface PagerState {
  screen: "pager";
  sessionId: string;
  top: number;
  /** The list to go back to, as it was left. */
  list: ListState;
  /** The transcript this subagent's was opened from; `q` returns there instead of the list. */
  parent?: PagerState;
  /** The selected item's key; the first item when unset. */
  sel?: string;
  /** Items opened with Enter: tool calls show their input and output, long messages all their lines. */
  expanded: string[];
  find: string;
  prompt?: string;
  thinking: boolean;
  /** Expand every tool call. */
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
  /** The list's search, source, project or sort changed: query the store again. */
  | { type: "reload" }
  | null;

/** A selectable piece of a transcript and the lines it spans (inclusive). */
export interface Item {
  key: string;
  kind: "message" | "thinking" | "tool";
  start: number;
  end: number;
  /** Whether Enter changes it: a tool call, or a message cut to its first lines. */
  expandable: boolean;
  /** For a call that spawned a subagent, that session's id. */
  subagent?: string;
  /** Everything the item holds, lowercased, including what a collapsed item doesn't show, so a find
   * reaches it. */
  search: string;
}

/** What the reducer needs to know about the screen: how many rows it has (sessions or transcript
 * lines), how many are visible, and for a transcript its plain text, turns and items. */
export interface Ctx {
  count: number;
  height: number;
  texts?: string[];
  turns?: number[];
  items?: Item[];
  /** The picker's entries, on the list. */
  options?: PickerOption[];
}

export interface Match {
  line: number;
  /** The item to open because the match is in a part it doesn't show yet. */
  open?: string;
}

/**
 * The next match for `query` past line `from` (`dir` 1), or before it (-1), with `inclusive` taking
 * `from` itself. Shown lines match where they contain it; a collapsed item whose hidden text has it
 * matches at its first line and asks to be opened.
 */
export function nextMatch(ctx: Ctx, query: string, from: number, dir: 1 | -1, inclusive = false): Match | null {
  const q = query.toLowerCase();
  if (!q) return null;
  const texts = ctx.texts ?? [];
  const items = ctx.items ?? [];
  const hits: Match[] = [];
  texts.forEach((t, i) => t.toLowerCase().includes(q) && hits.push({ line: i }));
  for (const it of items) {
    const shown = hits.some((h) => h.line >= it.start && h.line <= it.end);
    if (!shown && it.expandable && it.search.includes(q)) hits.push({ line: it.start, open: it.key });
  }
  hits.sort((a, b) => a.line - b.line);
  const ok = (l: number) => (dir === 1 ? (inclusive ? l >= from : l > from) : inclusive ? l <= from : l < from);
  const pick = dir === 1 ? hits.find((h) => ok(h.line)) : [...hits].reverse().find((h) => ok(h.line));
  return pick ?? null;
}

/** The sessions whose title, project path or id contains `filter`, any case. */
export function filterSessions(all: SessionSummary[], filter: string): SessionSummary[] {
  const q = filter.trim().toLowerCase();
  if (!q) return all;
  return all.filter((s) => [s.title, s.project_path, s.id].some((v) => v?.toLowerCase().includes(q)));
}

/** The index of the selected item: the one keyed `sel`, else the first. -1 when there are none. */
export function selectedIndex(items: Item[], sel: string | undefined): number {
  if (!items.length) return -1;
  const i = sel ? items.findIndex((it) => it.key === sel) : -1;
  return i < 0 ? 0 : i;
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
  // An open picker takes every key, so typing / or ? there doesn't reach the list.
  if (state.screen === "list" && state.picker) return listKey(state, key, ctx);

  if (state.prompt !== undefined) return typing(state, key, ctx);

  if (seq === "?") return none({ ...state, help: true });
  if (seq === "y") return { state, effect: { type: "copy" } };
  if (seq === "/") return none({ ...state, prompt: state.screen === "list" ? state.filter : "" });
  const page = Math.max(1, ctx.height - 1);

  if (state.screen === "list") return listKey(state, key, ctx);

  const items = ctx.items ?? [];
  const texts = ctx.texts ?? [];
  const last = Math.max(0, ctx.count - ctx.height);
  const clampTop = (t: number) => Math.max(0, Math.min(last, t));
  /** Select item `i` and scroll just enough to show it (its start, if it's taller than the screen). */
  const select = (i: number): State => {
    const it = items[Math.max(0, Math.min(items.length - 1, i))];
    if (!it) return state;
    let top = state.top;
    if (it.start < top) top = it.start;
    else if (it.end >= top + ctx.height) top = Math.min(it.start, it.end - ctx.height + 1);
    return { ...state, sel: it.key, top: clampTop(top) };
  };
  /** Put line `top` at the top and select the first item that starts on screen (or covers the top). */
  const scrollTo = (top: number, exact = false): State => {
    const t = exact ? Math.max(0, top) : clampTop(top);
    const it = items.find((x) => x.start >= t && x.start < t + ctx.height) ?? items.find((x) => x.start <= t && x.end >= t);
    return { ...state, top: t, sel: it?.key ?? state.sel };
  };
  const cur = selectedIndex(items, state.sel);

  if (name === "escape" && state.find) return none({ ...state, find: "" });
  if (name === "q" || name === "escape" || name === "left" || name === "h") return none(state.parent ?? state.list);
  if (name === "o") return { state, effect: { type: "open-web" } };
  if (name === "s") return { state, effect: { type: "open-subagent" } };
  if (name === "t") return none({ ...state, thinking: !state.thinking });
  if (name === "r") return none({ ...state, results: !state.results });
  if (name === "return" || name === "right" || name === "l") {
    const it = items[cur];
    if (!it?.expandable) return none();
    const open = state.expanded.includes(it.key);
    return none({ ...state, sel: it.key, expanded: open ? state.expanded.filter((k) => k !== it.key) : [...state.expanded, it.key] });
  }
  if (seq === "n" || seq === "N") {
    if (!state.find) return { state, effect: { type: "message", text: "Press / to find text first" } };
    const hit = nextMatch(ctx, state.find, state.top, seq === "n" ? 1 : -1);
    if (!hit) return { state, effect: { type: "message", text: `No more matches for "${state.find}"` } };
    return none(landOn(state, hit, items));
  }
  if (seq === "]" || seq === "[") {
    const turns = ctx.turns ?? [];
    const next = seq === "]" ? turns.find((t) => t > state.top) : [...turns].reverse().find((t) => t < state.top);
    return next === undefined ? none() : none(scrollTo(next, true));
  }
  if (name === "down" || name === "j") return none(items.length ? select(cur + 1) : scrollTo(state.top + 1));
  if (name === "up" || name === "k") return none(items.length ? select(cur - 1) : scrollTo(state.top - 1));
  if (name === "pagedown" || name === "space") return none(scrollTo(state.top + page));
  if (name === "pageup" || name === "b") return none(scrollTo(state.top - page));
  if (seq === "G" || name === "end") return none(items.length ? { ...select(items.length - 1), top: last } : scrollTo(last));
  if (name === "g" || name === "home") return none(items.length ? { ...select(0), top: 0 } : scrollTo(0));
  return none();
}

/** Keys on the session list, including its picker. */
function listKey(state: ListState, key: Key, ctx: Ctx): { state: State; effect: Effect } {
  const name = key.name ?? "";
  const seq = key.sequence ?? "";
  const none = (s: State = state) => ({ state: s, effect: null as Effect });
  const reload = (s: ListState) => ({ state: { ...s, cursor: 0, top: 0 } as State, effect: { type: "reload" } as Effect });
  const page = Math.max(1, ctx.height - 1);
  const scroll = (pos: { cursor: number; top: number }, count: number, to: number) => {
    const cursor = Math.max(0, Math.min(count - 1, to));
    const top = cursor < pos.top ? cursor : cursor >= pos.top + ctx.height ? cursor - ctx.height + 1 : pos.top;
    return { cursor, top: Math.max(0, top) };
  };
  const moveBy = (pos: { cursor: number; top: number }, count: number): { cursor: number; top: number } | null => {
    if (name === "down" || name === "j") return scroll(pos, count, pos.cursor + 1);
    if (name === "up" || name === "k") return scroll(pos, count, pos.cursor - 1);
    if (name === "pagedown" || name === "space") return scroll(pos, count, pos.cursor + page);
    if (name === "pageup" || name === "b") return scroll(pos, count, pos.cursor - page);
    if (seq === "G" || name === "end") return scroll(pos, count, count - 1);
    if (name === "g" || name === "home") return scroll(pos, count, 0);
    return null;
  };

  if (state.picker) {
    const options = ctx.options ?? [];
    if (name === "escape" || name === "q" || seq === "f") return none({ ...state, picker: undefined });
    if (name === "return") {
      const o = options[state.picker.cursor];
      if (!o) return none({ ...state, picker: undefined });
      const next: ListState = { ...state, picker: undefined, [o.group]: o.value ?? undefined };
      return next[o.group] === state[o.group] ? none(next) : reload(next);
    }
    const moved = moveBy(state.picker, options.length);
    return none(moved ? { ...state, picker: moved } : state);
  }

  if (name === "escape") {
    if (state.filter) return none({ ...state, filter: "", cursor: 0, top: 0 });
    if (state.search || state.source || state.project) return reload({ ...state, search: undefined, source: undefined, project: undefined });
    return { state, effect: { type: "quit" } };
  }
  if (name === "q") return { state, effect: { type: "quit" } };
  if (name === "return" || name === "right" || name === "l") return { state, effect: ctx.count ? { type: "open-pager" } : null };
  if (name === "o") return { state, effect: ctx.count ? { type: "open-web" } : null };
  if (seq === "f") {
    // Open on the current source, so the cursor starts where the user is.
    const options = ctx.options ?? [];
    const at = Math.max(0, options.findIndex((o) => o.group === "source" && (o.value ?? undefined) === state.source));
    return none({ ...state, picker: scroll({ cursor: 0, top: 0 }, options.length, at) });
  }
  if (seq === "s") {
    const column = SORT_COLUMNS[(SORT_COLUMNS.indexOf(state.sort.column) + 1) % SORT_COLUMNS.length];
    // Dates and counts read best largest first; names alphabetically.
    return reload({ ...state, sort: { column, desc: column === "started" || column === "turns" } });
  }
  if (seq === "r") return reload({ ...state, sort: { ...state.sort, desc: !state.sort.desc } });
  const moved = moveBy(state, ctx.count);
  return none(moved ? { ...state, ...moved } : state);
}

/** The sessions in the list's sort order. Ties keep the newest first. */
export function sortSessions(rows: SessionSummary[], sort: ListState["sort"]): SessionSummary[] {
  const key = (x: SessionSummary): string | number => {
    switch (sort.column) {
      case "title":
        return (x.title ?? x.id).toLowerCase();
      case "source":
        return (x.source_id ?? "").toLowerCase();
      case "project":
        return (x.project_path ? basename(x.project_path) : "").toLowerCase();
      case "turns":
        return x.turn_count;
      default:
        return x.started_at ?? "";
    }
  };
  const dir = sort.desc ? -1 : 1;
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return (ka < kb ? -1 : 1) * dir;
    return (b.started_at ?? "").localeCompare(a.started_at ?? "");
  });
}

/** Go to a find match: its line on top (even near the end, as `less` does, so the next `n` searches
 * past it), its item selected, and that item opened when the match is in a part it hides. */
function landOn(state: PagerState, hit: Match, items: Item[]): PagerState {
  const it = items.find((x) => x.start <= hit.line && x.end >= hit.line);
  const expanded = hit.open && !state.expanded.includes(hit.open) ? [...state.expanded, hit.open] : state.expanded;
  return { ...state, top: hit.line, sel: it?.key ?? state.sel, expanded };
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
    if (state.screen === "list") {
      // Enter turns the live filter into a full-text search of the store, transcripts included.
      const search = text.trim() || undefined;
      const next: ListState = { ...state, prompt: undefined, filter: "", search, cursor: 0, top: 0 };
      return { state: next, effect: search !== state.search ? { type: "reload" } : null };
    }
    const next: PagerState = { ...state, prompt: undefined, find: text };
    if (!text) return { state: next, effect: null };
    const hit = nextMatch(ctx, text, state.top, 1, true) ?? nextMatch(ctx, text, 0, 1, true);
    if (!hit) return { state: next, effect: { type: "message", text: `No match for "${text}"` } };
    return { state: landOn(next, hit, ctx.items ?? []), effect: null };
  }
  if (key.name === "backspace") return { state: set(text.slice(0, -1)), effect: null };
  const ch = printable(key);
  return { state: ch ? set(text + ch) : state, effect: null };
}

const pad = (s: string, w: number): string => (s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length));
const footer = (text: string, width: number, color: boolean): string => drawLine([[text, "dim"]], width, color);
const promptLine = (text: string, hint: string, width: number, color: boolean): string =>
  drawLine([["/", "bold"], [text], ["█", "dim"], [`   ${hint}`, "dim"]], width, color);

const LIST_COLS = { when: 16, marker: 2, source: 10, project: 16, turns: 7 } as const; // turns fits "turns ▲"
const titleWidth = (width: number): number =>
  Math.max(4, width - LIST_COLS.when - 2 - LIST_COLS.marker - 2 - LIST_COLS.source - 2 - LIST_COLS.project - 2 - LIST_COLS.turns);

/** One list row: when, a severity marker, title, source, project, turns. */
function listRow(x: SessionSummary, width: number): Line {
  const marker: Span = x.finding_count ? ["● ", severityStyle(x.worst_severity)] : ["  "];
  const titleW = titleWidth(width);
  const title = clean(x.title ?? x.id).replace(/\n/g, " ");
  const titleSpan = [...title].length > titleW ? [...title].slice(0, titleW - 1).join("") + "…" : pad(title, titleW);
  return [
    [fmtWhen(x.started_at).padEnd(LIST_COLS.when), "dim"], ["  "], marker, [titleSpan, "bold"], ["  "],
    [pad(x.source_id ?? "", LIST_COLS.source), "dim"], ["  "],
    [pad(x.project_path ? basename(x.project_path) : "", LIST_COLS.project), "project"], ["  "],
    [String(x.turn_count).padStart(LIST_COLS.turns), "cost"],
  ];
}

/** The column header row: labels over the row's columns, the sorted one marked ▼ or ▲. */
function columnHeader(sort: ListState["sort"], width: number): Line {
  const label = (c: SortColumn, w: number, right = false): Span => {
    const text = c + (sort.column === c ? (sort.desc ? " ▼" : " ▲") : "");
    return [right ? text.padStart(w) : pad(text, w), sort.column === c ? "bold" : "dim"];
  };
  return [
    label("started", LIST_COLS.when), ["  "], [" ".repeat(LIST_COLS.marker)], label("title", titleWidth(width)), ["  "],
    label("source", LIST_COLS.source), ["  "], label("project", LIST_COLS.project), ["  "], label("turns", LIST_COLS.turns, true),
  ];
}

/** The picker over the list: every source, then every project, with counts; the current ones
 * marked. */
function renderPicker(s: ListState, options: PickerOption[], width: number, height: number, color: boolean, theme: Theme): string[] {
  const p = s.picker!;
  const body = Math.max(1, height - 2);
  const lines = [drawLine([["Filter by source or project", "title"]], width, color)];
  for (let i = p.top; i < p.top + body; i++) {
    const o = options[i];
    if (!o) {
      lines.push(" ".repeat(width));
      continue;
    }
    const current = (o.value ?? undefined) === s[o.group];
    const row: Line = [
      [current ? "● " : "  ", "turn"],
      [pad(o.group, 9), "dim"],
      [o.label, o.value ? "plain" : "italic"],
      ...(o.count !== undefined ? ([[`  ${o.count}`, "dim"]] as Line) : []),
    ];
    lines.push(drawLine(row, width, color, i === p.cursor ? (color ? SELECTED_BG[theme] : "7") : ""));
  }
  lines.push(footer("↑↓ move · enter choose · esc close", width, color));
  return lines;
}

/**
 * The list screen: a header with the count and any active search, source or project; the column
 * headers with the sort; one row per visible session (the selected one tinted or inverted); and a
 * footer with the keys, the text being typed, or a message. Exactly `height` lines of `width`
 * columns. `sessions` is the loaded list after the live filter and the sort; `loaded` is how many
 * were loaded and `total` how many match in the store.
 */
export function renderList(
  sessions: SessionSummary[],
  s: ListState,
  width: number,
  height: number,
  message = "",
  color = false,
  total = sessions.length,
  theme: Theme = "dark",
  options: PickerOption[] = [],
  loaded = sessions.length,
): string[] {
  if (s.help) return renderHelp("list", width, height, color);
  if (s.picker) return renderPicker(s, options, width, height, color, theme);
  const body = Math.max(1, height - 3);
  const count = s.filter ? `${sessions.length} of ${loaded}` : loaded < total ? `${loaded} of ${total}` : String(total);
  const head: Line = [[`Sessions (${count})`, "title"]];
  const labelOf = (group: "source" | "project", v: string) => options.find((o) => o.group === group && o.value === v)?.label ?? v;
  if (s.search) head.push([`  search: ${s.search}`, "turn"]);
  if (s.source) head.push([`  source: ${labelOf("source", s.source)}`, "turn"]);
  if (s.project) head.push([`  project: ${labelOf("project", s.project)}`, "turn"]);
  if (s.filter && s.prompt === undefined) head.push([`  filter: ${s.filter}`, "turn"]);
  head.push(["  ● has findings", "dim"]);
  const lines = [drawLine(head, width, color), drawLine(columnHeader(s.sort, width), width, color)];
  for (let i = s.top; i < s.top + body; i++) {
    const x = sessions[i];
    if (!x) lines.push(" ".repeat(width));
    // The selected row is tinted when colour is on, inverted without it.
    else lines.push(drawLine(listRow(x, width), width, color, i === s.cursor ? (color ? SELECTED_BG[theme] : "7") : ""));
  }
  if (s.prompt !== undefined) lines.push(promptLine(s.prompt, "filters as you type · enter searches transcripts · esc clears", width, color));
  else if (message) lines.push(footer(message, width, color));
  else {
    const clear = s.search || s.source || s.project ? " · esc clear filters" : "";
    lines.push(footer(`↑↓ move · enter read · / search · f filter · s sort${clear} · ? help · q quit`, width, color));
  }
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

/** Columns the transcript gives up on the left for the selection bar. */
export const GUTTER = 2;

/** The pager screen: the session title, a window of its transcript with the selected item tinted
 * (or, without colour, barred on the left) and find matches inverted, and a footer with the
 * position, the find being typed, or a message. */
export function renderPager(
  title: string,
  t: Transcript,
  s: PagerState,
  width: number,
  height: number,
  message = "",
  color = false,
  theme: Theme = "dark",
): string[] {
  if (s.help) return renderHelp("pager", width, height, color);
  const body = Math.max(1, height - 2);
  const sel = t.items[selectedIndex(t.items, s.sel)];
  const lines = [drawLine([[clean(title).replace(/\n/g, " "), "title"]], width, color)];
  for (let i = s.top; i < s.top + body; i++) {
    const picked = !!sel && i >= sel.start && i <= sel.end;
    const line = highlight(t.lines[i] ?? [], s.find);
    if (picked && color) lines.push(drawLine([["  "], ...line], width, color, SELECTED_BG[theme]));
    else lines.push(drawLine([picked ? ["▌ ", "gutter"] : ["  "], ...line], width, color));
  }
  const end = Math.min(t.lines.length, s.top + body);
  const pos = t.lines.length ? `${s.top + 1}–${end} of ${t.lines.length}` : "empty";
  const shown = [s.thinking && "thinking", s.results && "all tool calls"].filter(Boolean).join(", ");
  if (s.prompt !== undefined) lines.push(promptLine(s.prompt, "enter find · esc cancel", width, color));
  else if (message) lines.push(footer(message, width, color));
  else if (s.find) lines.push(footer(`${pos} · "${s.find}": n next · N previous · esc clear`, width, color));
  else {
    const hint = sel?.expandable ? ` · enter ${s.expanded.includes(sel.key) || (sel.kind === "tool" && s.results) ? "collapse" : "expand"}` : "";
    lines.push(footer(`${pos}${shown ? ` · showing ${shown}` : ""} · ↑↓ item${hint} · [ ] turns · / find · ? help · q back`, width, color));
  }
  return lines;
}

const HELP: Record<"list" | "pager", Array<[string, string]>> = {
  list: [
    ["↑ ↓  j k", "move"],
    ["space b  PgDn PgUp", "page"],
    ["g G  Home End", "first, last"],
    ["enter  →", "read the transcript"],
    ["/", "filter by title, project or id as you type; enter searches transcripts too"],
    ["f", "filter by source or project"],
    ["s  r", "sort by the next column, reverse the order"],
    ["esc", "clear the search and filters (quits when there are none)"],
    ["o", "open in the web UI (needs agent-lens serve)"],
    ["y", "copy the session id"],
    ["q", "quit"],
  ],
  pager: [
    ["↑ ↓  j k", "previous, next message or tool call"],
    ["enter  →", "expand or collapse it (a tool call's input and output)"],
    ["space b  PgDn PgUp", "page"],
    ["g G  Home End", "top, bottom"],
    ["[ ]", "previous, next turn"],
    ["/  n N", "find text, next, previous (esc clears)"],
    ["t", "show or hide thinking"],
    ["r", "expand or collapse every tool call"],
    ["s", "open the selected [s] call's subagent"],
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

export { toolLine };

/** Lines a message shows before "… N more lines" until it is expanded. */
export const MESSAGE_PREVIEW = 12;
/** Messages longer than this are cut to the preview. */
export const MESSAGE_LONG = 20;

export interface Transcript {
  lines: Line[];
  /** The line each turn's rule is on, in order. */
  turns: number[];
  /** The messages, thinking blocks and tool calls, in order, with the lines they span. */
  items: Item[];
  /** Tool calls that spawned a subagent: the line they are on and the subagent's session id. */
  subagents: Array<{ line: number; sessionId: string }>;
}

export interface TranscriptOpts {
  thinking?: boolean;
  /** Expand every tool call. */
  results?: boolean;
  /** Keys of the items opened one by one. */
  expanded?: string[];
}

/**
 * A session's transcript as styled lines, `width` columns wide (the pager adds its gutter): a short
 * header, then each turn's messages, rendered as markdown, and tool calls, each speaker labelled once
 * per run. Thinking is left out unless asked for; tool calls are one line until expanded, and long
 * messages show their first lines.
 */
export function transcriptLines(d: SessionDetail, width: number, show: TranscriptOpts = {}): Transcript {
  const s = d.session;
  const out: Line[] = [];
  const turns: number[] = [];
  const items: Item[] = [];
  const subagents: Transcript["subagents"] = [];
  const open = new Set(show.expanded ?? []);
  const inner = Math.max(10, width - 2); // inside a card's "│ " bar
  const meta = `${fmtWhen(s.started_at)} · ${s.project_path ?? ""} · ${d.turns.length} turns · ${fmtUsd(s.cost)}`;
  for (const l of wrap(meta, width)) out.push([[l, "dim"]]);
  const turnRows = new Map(d.turns.map((t) => [t.id, t]));

  // A card is one speaker's run of messages and tool calls: a top border naming the speaker and the
  // time, a bar in the speaker's colour down the left, and a closing corner.
  // Held in an object so the helpers below can change it (TypeScript doesn't follow closure writes).
  const at: { card: { who: string; bar: Style } | null } = { card: null };
  const inCard = (l: Line): Line => [["│ ", at.card?.bar ?? "dim"], ...l];
  const close = () => {
    if (at.card) out.push([["╰─", at.card.bar]]);
    at.card = null;
  };
  const openCard = (who: string, when: string | null) => {
    close();
    const bar: Style = who === "you" ? "youBar" : who === "claude" ? "claudeBar" : "dim";
    const time = fmtClock(when);
    const fill = Math.max(1, width - 4 - who.length - (time ? time.length + 1 : 0));
    out.push([["╭─ ", bar], [who, who === "you" ? "you" : who === "claude" ? "claude" : "bold"], [` ${"─".repeat(fill)}`, bar], ...(time ? ([[` ${time}`, "dim"]] as Line) : [])]);
    at.card = { who, bar };
  };

  let turn: string | null = null;
  let n = 0;
  for (const e of d.events) {
    if (e.turn_id && e.turn_id !== turn) {
      close();
      turn = e.turn_id;
      n++;
      const row = turnRows.get(e.turn_id);
      const info = [fmtClock(row?.started_at ?? e.timestamp), row?.duration_ms ? fmtSpan(row.duration_ms) : ""].filter(Boolean).join(" · ");
      const label = ` Turn ${n}${info ? ` · ${info}` : ""} `;
      out.push([]);
      turns.push(out.length);
      out.push([["━━", "turn"], [label, "turnTitle"], ["━".repeat(Math.max(2, width - 2 - label.length)), "turn"]]);
      out.push([]);
    }
    const text = e.text ? clean(e.text).trim() : "";
    const thinking = show.thinking && e.thinking ? clean(e.thinking).trim() : "";
    if (!text && !thinking && !e.toolCalls.length) continue;
    const who = e.role === "user" ? "you" : e.role === "assistant" ? "claude" : e.type;
    if (at.card?.who !== who) openCard(who, e.timestamp);
    if (thinking) {
      const start = out.length;
      out.push(inCard([["thinking", "thinking"]]), ...markdownLines(thinking, inner - 2, "thinking").map((l) => inCard([["┆ ", "dim"], ...l])));
      items.push({ key: `think:${e.uuid}`, kind: "thinking", start, end: out.length - 1, expandable: false, search: thinking.toLowerCase() });
    }
    if (text) {
      const key = `msg:${e.uuid}`;
      const all = markdownLines(text, inner);
      const cut = all.length > MESSAGE_LONG && !open.has(key);
      const start = out.length;
      out.push(...(cut ? all.slice(0, MESSAGE_PREVIEW) : all).map(inCard));
      if (cut) out.push(inCard([[`… ${all.length - MESSAGE_PREVIEW} more lines · enter shows all`, "dim"]]));
      items.push({ key, kind: "message", start, end: out.length - 1, expandable: all.length > MESSAGE_LONG, search: text.toLowerCase() });
    }
    e.toolCalls.forEach((t, i) => {
      const key = `tool:${t.id ?? `${e.uuid}:${i}`}`;
      const expanded = !!show.results || open.has(key);
      const start = out.length;
      if (t.spawned_session_id) subagents.push({ line: start, sessionId: t.spawned_session_id });
      out.push(inCard(toolLine(t, expanded)));
      if (expanded) out.push(...toolDetailLines(t, inner - 2).map((l) => inCard([["  "], ...l])));
      const search = [t.tool_name, t.input_json, t.full_result?.text ?? t.result_summary].filter(Boolean).join("\n").toLowerCase();
      items.push({ key, kind: "tool", start, end: out.length - 1, expandable: true, subagent: t.spawned_session_id ?? undefined, search });
    });
  }
  close();
  return { lines: out, turns, items, subagents };
}

/** `14:05`, in the terminal's local time. */
function fmtClock(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** A duration as `45s`, `3m 20s` or `1h 05m`. */
export function fmtSpan(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${String(sec % 60).padStart(2, "0")}s`;
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
}
