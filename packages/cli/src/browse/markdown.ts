/**
 * Markdown in a terminal, for `agent-lens browse`: the common block and inline forms become styled
 * spans instead of raw `#`, `*` and backticks. Not a full CommonMark parser, by design: it covers
 * what agent messages use (headings, emphasis, inline and fenced code, lists, quotes, rules, links,
 * tables) and leaves anything else as plain text. Pure, so it is tested without a terminal.
 */
import { type Line, type Span, type Style } from "./style.js";
import { charWidth, displayWidth } from "./text.js";

// Inline forms, in priority order. Emphasis needs a non-word character (or an edge) on its outer side,
// so snake_case and 2*3*4 stay as they are.
const INLINE =
  /(`+)([^`]+?)\1|\*\*(?=\S)(.+?)(?<=\S)\*\*|__(?=\S)(.+?)(?<=\S)__|(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])|(?<![\w_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\w_])|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** One line of markdown text as styled spans. `base` is the style of the plain parts. */
export function inline(text: string, base: Style = "plain"): Span[] {
  const out: Span[] = [];
  let at = 0;
  const push = (t: string, s: Style) => t && out.push([t, s]);
  for (const m of text.matchAll(INLINE)) {
    push(text.slice(at, m.index), base);
    if (m[2] !== undefined) push(m[2], "code");
    else if (m[3] !== undefined || m[4] !== undefined) push(m[3] ?? m[4], base === "heading" ? "heading" : "bold");
    else if (m[5] !== undefined || m[6] !== undefined) push(m[5] ?? m[6], "italic");
    else if (m[7] !== undefined) {
      push(m[7], "link");
      if (m[8] !== m[7]) push(` (${m[8]})`, "dim");
    }
    at = m.index + m[0].length;
  }
  push(text.slice(at), base);
  return out;
}

/** Wrap styled spans into lines of at most `width` columns, breaking at spaces where it can and
 * mid-word where a word is longer than a line. Styles carry across the breaks, and leading spaces
 * (indentation) are kept. */
export function wrapSpans(spans: Span[], width: number): Line[] {
  const w = Math.max(1, width);
  const lines: Line[] = [];
  let cur: Line = [];
  let used = 0;
  const add = (t: string, s: Style | undefined) => {
    const last = cur[cur.length - 1];
    if (last && last[1] === s) last[0] += t;
    else cur.push([t, s]);
    used += displayWidth(t);
  };
  const breakLine = () => {
    const last = cur[cur.length - 1];
    if (last) last[0] = last[0].replace(/ +$/, "");
    lines.push(cur.filter(([t]) => t));
    cur = [];
    used = 0;
  };
  for (const [text, style] of spans) {
    for (const token of text.split(/( +)/)) {
      if (!token) continue;
      const tw = displayWidth(token);
      if (token.startsWith(" ")) {
        // Spaces separate words, except at the very start, where they are indentation (code, JSON).
        const atStart = !lines.length && !cur.length;
        if ((used > 0 || atStart) && used + tw <= w) add(token, style);
        continue;
      }
      if (used + tw > w && used > 0) breakLine();
      if (tw <= w) {
        add(token, style);
        continue;
      }
      for (const ch of token) {
        if (used + charWidth(ch) > w) breakLine();
        add(ch, style);
      }
    }
  }
  if (cur.length || !lines.length) breakLine();
  return lines;
}

/** `spans` wrapped to `width`, the first line led by `first` and the rest by `rest` (a hanging
 * indent), both given as spans. */
function hang(spans: Span[], width: number, first: Span[], rest: Span[]): Line[] {
  const lead = displayWidth(first.map(([t]) => t).join(""));
  return wrapSpans(spans, width - lead).map((l, i) => [...(i ? rest : first), ...l]);
}

const tableCells = (row: string): string[] => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

const plainWidth = (spans: Span[]): number => displayWidth(spans.map(([t]) => t).join(""));
const isRule = (cells: string[]): boolean => cells.every((c) => /^:?-{2,}:?$/.test(c));

/** A markdown table: columns padded to line up when it fits `width`, else each row wrapped. */
function tableLines(rows: string[][], width: number, base: Style): Line[] {
  const cells = rows.map((r) => (isRule(r) ? null : r.map((c) => inline(c, base))));
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, j) => Math.max(0, ...cells.map((r) => (r?.[j] ? plainWidth(r[j]) : 0))));
  const total = widths.reduce((a, b) => a + b, 0) + 3 * (cols - 1);
  const out: Line[] = [];
  for (const r of cells) {
    if (!r) {
      out.push([["─".repeat(Math.min(width, total)), "dim"]]);
      continue;
    }
    const row: Span[] = [];
    r.forEach((c, j) => {
      if (j) row.push([" │ ", "dim"]);
      row.push(...c);
      if (total <= width && j < r.length - 1) row.push([" ".repeat(widths[j] - plainWidth(c))]);
    });
    out.push(...wrapSpans(row, width));
  }
  return out;
}

/** A message's markdown as styled lines, wrapped to `width`. */
export function markdownLines(text: string, width: number, base: Style = "plain"): Line[] {
  const out: Line[] = [];
  const src = text.split("\n");
  for (let i = 0; i < src.length; i++) {
    const raw = src[i];
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(raw);
    if (fence) {
      // The fence lines go; the code keeps its own line breaks, dimly ruled on the left.
      if (fence[2]) out.push([["  " + fence[2], "dim"]]);
      for (i++; i < src.length && !src[i].trimStart().startsWith(fence[1]); i++) {
        out.push(...hang([[src[i], "code"]], width, [["│ ", "dim"]], [["│ ", "dim"]]));
      }
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    if (heading) {
      out.push(...wrapSpans(inline(heading[2], "heading"), width));
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      out.push([["─".repeat(Math.min(width, 40)), "dim"]]);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(raw);
    if (quote) {
      out.push(...hang(inline(quote[1], "italic"), width, [["│ ", "dim"]], [["│ ", "dim"]]));
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(raw);
    if (item) {
      const pad = " ".repeat(Math.min(item[1].length, 8));
      const box = item[3] === undefined ? "" : item[3] === " " ? "☐ " : "☑ ";
      const bullet = /^\d/.test(item[2]) ? `${item[2]} ` : "• ";
      const first: Span[] = [[pad], [bullet + box, "dim"]];
      out.push(...hang(inline(item[4], base), width, first, [[" ".repeat(pad.length + bullet.length + box.length)]]));
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      // The whole table at once, so its columns can line up when it fits the width.
      const rows: string[][] = [];
      for (; i < src.length && /^\s*\|.*\|\s*$/.test(src[i]); i++) rows.push(tableCells(src[i]));
      i--;
      out.push(...tableLines(rows, width, base));
      continue;
    }
    if (!raw.trim()) {
      out.push([]);
      continue;
    }
    out.push(...wrapSpans(inline(raw.trim(), base), width));
  }
  // Collapse runs of blank lines a message's own spacing would leave.
  return out.filter((l, j) => l.length || (j > 0 && out[j - 1].length));
}
