/**
 * Styled terminal lines for `agent-lens browse`. A line is a list of spans, each a piece of text and a
 * style name; widths are measured on the text alone, and escape codes are added only when a line is
 * drawn. The 16 basic ANSI colours are used so the terminal's own theme decides the shades.
 */
import { charWidth } from "./text.js";

export type Style =
  | "plain" | "dim" | "bold" | "title" | "you" | "claude" | "tool" | "toolName" | "error"
  | "turn" | "code" | "heading" | "project" | "cost"
  | "critical" | "high" | "medium" | "low" | "info";

export type Span = [text: string, style?: Style];
export type Line = Span[];

const SGR: Record<Style, string> = {
  plain: "",
  dim: "2",
  bold: "1",
  title: "1",
  you: "1;32",
  claude: "1;35",
  tool: "2",
  toolName: "33",
  error: "31",
  turn: "36",
  code: "36",
  heading: "1",
  project: "36",
  cost: "",
  critical: "1;31",
  high: "31",
  medium: "33",
  low: "36",
  info: "2",
};

/** Whether to colour: an interactive terminal, unless NO_COLOR is set (https://no-color.org). */
export function useColor(env: NodeJS.ProcessEnv = process.env, isTTY = !!process.stdout.isTTY): boolean {
  return isTTY && !env.NO_COLOR;
}

/** Draw a line at exactly `width` columns: cut with "…" when too long, padded when short. `base` is an
 * SGR code kept under every span (the inverted selected row). */
export function drawLine(line: Line, width: number, color: boolean, base = ""): string {
  const total = line.reduce((w, [t]) => w + [...t].reduce((a, ch) => a + charWidth(ch), 0), 0);
  const room = total <= width ? width : width - 1;
  let used = 0;
  let out = "";
  for (const [text, style = "plain"] of line) {
    let piece = "";
    for (const ch of text) {
      const cw = charWidth(ch);
      if (used + cw > room) break;
      piece += ch;
      used += cw;
    }
    if (piece) out += color && SGR[style] ? `\x1b[${SGR[style]}m${piece}\x1b[0m${base ? `\x1b[${base}m` : ""}` : piece;
    if (used >= room) break;
  }
  if (total > width) (out += "…"), used++;
  out += " ".repeat(Math.max(0, width - used));
  return base ? `\x1b[${base}m${out}\x1b[0m` : out;
}

/** The style a finding severity is drawn in. */
export const severityStyle = (s: string | null | undefined): Style =>
  s === "critical" || s === "high" || s === "medium" || s === "low" ? s : "info";
