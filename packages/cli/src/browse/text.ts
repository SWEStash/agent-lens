/**
 * Terminal text for `agent-lens browse`: cleaning, display width, wrapping and fitting. Pure, so it is
 * tested without a terminal (ADR-042).
 */
import { stripVTControlCharacters } from "node:util";

/**
 * Make transcript text safe to print: escape sequences and control characters are removed, so a
 * transcript can never move the cursor, clear the screen or retitle the terminal. Tabs become spaces
 * and line endings become `\n`.
 */
export function clean(s: string): string {
  return stripVTControlCharacters(s)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, "");
}

const ZERO_WIDTH = /[\p{Mn}\p{Me}\p{Cf}]/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
// East Asian Wide and Fullwidth blocks: Hangul Jamo, CJK and symbols, Hiragana to CJK compatibility,
// Hangul syllables, CJK compatibility ideographs, vertical and fullwidth forms, CJK extensions B+.
const WIDE: Array<[number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x20000, 0x3fffd],
];

/** Columns one character takes: 0 for combining marks and format characters, 2 for wide CJK and
 * emoji, else 1. */
export function charWidth(ch: string): number {
  if (ZERO_WIDTH.test(ch)) return 0;
  const cp = ch.codePointAt(0)!;
  if (cp >= 0x1f000 && PICTOGRAPHIC.test(ch)) return 2;
  for (const [lo, hi] of WIDE) if (cp >= lo && cp <= hi) return 2;
  return 1;
}

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

/** Cut `s` to at most `width` columns, ending in "…" when cut, then pad it to exactly `width`. */
export function fit(s: string, width: number): string {
  if (width <= 0) return "";
  let w = 0;
  let out = "";
  const full = displayWidth(s) <= width;
  const room = full ? width : width - 1;
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > room) break;
    out += ch;
    w += cw;
  }
  if (!full) (out += "…"), w++;
  return out + " ".repeat(Math.max(0, width - w));
}

/** Wrap one cleaned text into lines of at most `width` columns, breaking at spaces where it can and
 * mid-word where a word is longer than the line. Blank lines are kept. */
export function wrap(s: string, width: number): string[] {
  const out: string[] = [];
  const w = Math.max(1, width);
  for (const para of s.split("\n")) {
    if (!para) {
      out.push("");
      continue;
    }
    let line = "";
    let lineW = 0;
    for (const word of para.split(/(?<= )/)) {
      const ww = displayWidth(word);
      if (lineW + ww <= w) {
        line += word;
        lineW += ww;
        continue;
      }
      if (line) out.push(line.trimEnd());
      line = "";
      lineW = 0;
      for (const ch of word) {
        const cw = charWidth(ch);
        if (lineW + cw > w) {
          out.push(line);
          line = "";
          lineW = 0;
        }
        line += ch;
        lineW += cw;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}
