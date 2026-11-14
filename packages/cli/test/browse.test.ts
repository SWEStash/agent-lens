/**
 * `agent-lens browse` without a terminal: text cleaning and wrapping, the two screens, and the key
 * reducer are pure functions (ADR-042). The terminal driver itself is exercised by hand in a pty.
 */
import { describe, it, expect } from "vitest";
import type { SessionDetail, SessionSummary, ToolCall } from "@agent-lens/contracts";
import { charWidth, clean, displayWidth, fit, wrap } from "../src/browse/text.js";
import { reduce, renderList, renderPager, toolLine, transcriptLines, type ListState, type PagerState } from "../src/browse/view.js";
import { drawLine, useColor, type Line } from "../src/browse/style.js";
import { sessionUrl } from "../src/browse/index.js";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const txt = (l: Line) => l.map(([t]) => t).join("");

describe("text", () => {
  it("clean strips escape sequences and control characters a transcript could carry", () => {
    expect(clean("ok\x1b[2J\x1b]0;pwned\x07 done")).toBe("ok done");
    expect(clean("a\r\nb\tc\u0000\u009b")).toBe("a\nb    c");
  });

  it("measures wide and zero-width characters", () => {
    expect(charWidth("a")).toBe(1);
    expect(charWidth("漢")).toBe(2);
    expect(charWidth("🚀")).toBe(2);
    expect(charWidth("́")).toBe(0);
    expect(displayWidth("é漢🚀")).toBe(5);
  });

  it("fit cuts to the width with an ellipsis and pads short text", () => {
    expect(fit("hello world", 8)).toBe("hello w…");
    expect(fit("hi", 5)).toBe("hi   ");
    expect(displayWidth(fit("漢字漢字漢字", 7))).toBe(7);
  });

  it("wrap breaks at spaces, splits an over-long word, and keeps blank lines", () => {
    expect(wrap("the quick brown fox", 10)).toEqual(["the quick", "brown fox"]);
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrap("a\n\nb", 10)).toEqual(["a", "", "b"]);
    for (const l of wrap("漢字 漢字漢字 漢字", 5)) expect(displayWidth(l)).toBeLessThanOrEqual(5);
  });
});

describe("reduce", () => {
  const list: ListState = { screen: "list", cursor: 0, top: 0 };

  it("moves the list cursor and scrolls to keep it visible", () => {
    let s: ListState = list;
    for (let i = 0; i < 5; i++) s = reduce(s, { name: "down" }, 10, 3).state as ListState;
    expect(s).toEqual({ screen: "list", cursor: 5, top: 3 });
    s = reduce(s, { name: "g" }, 10, 3).state as ListState;
    expect(s).toEqual({ screen: "list", cursor: 0, top: 0 });
    s = reduce(s, { name: "g", sequence: "G", shift: true }, 10, 3).state as ListState;
    expect(s.cursor).toBe(9);
    expect(reduce(list, { name: "up" }, 10, 3).state).toEqual(list);
  });

  it("opens the pager, opens the web UI, and quits", () => {
    expect(reduce(list, { name: "return" }, 10, 3).effect).toEqual({ type: "open-pager" });
    expect(reduce(list, { name: "o" }, 10, 3).effect).toEqual({ type: "open-web" });
    expect(reduce(list, { name: "q" }, 10, 3).effect).toEqual({ type: "quit" });
    expect(reduce(list, { name: "c", ctrl: true }, 10, 3).effect).toEqual({ type: "quit" });
    expect(reduce(list, { name: "return" }, 0, 3).effect).toBeNull(); // nothing to open
  });

  it("scrolls the pager within bounds and goes back to the list as it was left", () => {
    const left: ListState = { screen: "list", cursor: 4, top: 2 };
    const pager: PagerState = { screen: "pager", top: 0, list: left };
    expect((reduce(pager, { name: "space" }, 50, 10).state as PagerState).top).toBe(9);
    expect((reduce(pager, { name: "end" }, 50, 10).state as PagerState).top).toBe(40);
    expect((reduce(pager, { name: "up" }, 50, 10).state as PagerState).top).toBe(0);
    expect(reduce(pager, { name: "q" }, 50, 10).state).toEqual(left);
    expect(reduce(pager, { name: "c", ctrl: true }, 50, 10).effect).toEqual({ type: "quit" });
  });
});

const session = (id: string, title: string): SessionSummary =>
  ({ id, title, started_at: null, project_path: "/w/demo", cost: 1.5, unpriced_models: [] }) as unknown as SessionSummary;

describe("screens", () => {
  it("renderList draws exactly the terminal's size, the selected row inverted", () => {
    const rows = [session("a", "first"), session("b", "second")];
    const out = renderList(rows, { screen: "list", cursor: 1, top: 0 }, 60, 6);
    expect(out).toHaveLength(6);
    for (const l of out) expect(displayWidth(plain(l))).toBe(60);
    expect(out[2].startsWith("\x1b[7m")).toBe(true);
    expect(plain(out[2])).toContain("second");
    expect(plain(out[5])).toContain("q quit");
  });

  it("renderPager shows a window of the transcript and where it is", () => {
    const lines: Line[] = Array.from({ length: 30 }, (_, i) => [[`line ${i + 1}`]]);
    const out = renderPager("Title", lines, { screen: "pager", top: 5, list: { screen: "list", cursor: 0, top: 0 } }, 40, 6);
    expect(out.map((l) => plain(l).trimEnd())).toEqual(["Title", "line 6", "line 7", "line 8", "line 9", expect.stringMatching(/^6–9 of 30/)]);
  });

  it("toolLine names the call, then its failure and worst finding, then what it acted on", () => {
    const t = (o: Partial<ToolCall>): ToolCall => ({ tool_name: "Bash", input_json: null, status: null, skill_name: null, agent_type: null, ...o }) as ToolCall;
    expect(txt(toolLine(t({ input_json: JSON.stringify({ command: "pnpm test\nmore" }) })))).toBe("⏺ Bash: pnpm test");
    const failed = toolLine(t({ tool_name: "Edit", input_json: JSON.stringify({ file_path: "src/a.ts" }), status: "error" }));
    expect(txt(failed)).toBe("⏺ Edit (failed): src/a.ts");
    expect(failed).toContainEqual([" (failed)", "error"]);
    expect(txt(toolLine(t({ tool_name: "Task", agent_type: "Explore", input_json: "not json" })))).toBe("⏺ Task → Explore");
    const flagged = toolLine(t({ input_json: '{"command":"rm -rf /"}', findings: [{ severity: "critical", rule_id: "destructive.rm_rf" }] as never }));
    expect(txt(flagged)).toBe("⏺ Bash ● critical destructive.rm_rf: rm -rf /");
    expect(flagged).toContainEqual([" ● critical destructive.rm_rf", "critical"]);
  });

  it("transcriptLines labels each speaker once per run, tool calls under claude, and never passes escapes through", () => {
    const d = {
      session: { started_at: null, project_path: "/w/demo", cost: 0 },
      turns: [{}],
      events: [
        { role: "user", type: "user", turn_id: "t0", text: "fix it\x1b[2J", toolCalls: [] },
        { role: "assistant", type: "assistant", turn_id: "t0", text: null, toolCalls: [{ tool_name: "Bash", input_json: '{"command":"ls"}' }] },
        { role: "assistant", type: "assistant", turn_id: "t0", text: "done", toolCalls: [] },
      ],
    } as unknown as SessionDetail;
    const out = transcriptLines(d, 40).map(txt);
    expect(out.filter((l) => l === "claude:")).toHaveLength(1);
    expect(out.slice(out.indexOf("claude:"))).toEqual(["claude:", "  ⏺ Bash: ls", "  done"]);
    expect(out.join("\n")).not.toContain("\x1b");
  });
});

describe("style", () => {
  it("drawLine colours spans only when colour is on, and measures width without the codes", () => {
    const line: Line = [["ok ", "plain"], ["failed", "error"]];
    expect(drawLine(line, 12, false)).toBe("ok failed   ");
    const coloured = drawLine(line, 12, true);
    expect(coloured).toBe("ok \x1b[31mfailed\x1b[0m   ");
    expect(plain(coloured)).toBe("ok failed   ");
    expect(drawLine(line, 6, false)).toBe("ok fa…");
  });

  it("keeps the inverted selection under every span, even without colour", () => {
    const out = drawLine([["a", "error"], ["b"]], 3, true, "7");
    expect(out.startsWith("\x1b[7m")).toBe(true);
    expect(out).toContain("\x1b[0m\x1b[7m"); // the span's reset re-applies the inversion
    expect(drawLine([["a"]], 2, false, "7")).toBe("\x1b[7ma \x1b[0m");
  });

  it("colours a TTY unless NO_COLOR is set", () => {
    expect(useColor({}, true)).toBe(true);
    expect(useColor({ NO_COLOR: "1" }, true)).toBe(false);
    expect(useColor({}, false)).toBe(false);
  });

  it("transcript styles headings and fenced code, and labels speakers", () => {
    const d = {
      session: { started_at: null, project_path: "/w", cost: 0 },
      turns: [{}],
      events: [{ role: "assistant", type: "assistant", turn_id: "t0", text: "## Plan\n```\nls\n```\ndone", toolCalls: [] }],
    } as unknown as SessionDetail;
    const out = transcriptLines(d, 40);
    const styleOf = (text: string) => out.find((l) => txt(l).trim() === text)?.at(-1)?.[1];
    expect(styleOf("claude:")).toBe("claude");
    expect(styleOf("## Plan")).toBe("heading");
    expect(styleOf("ls")).toBe("code");
    expect(styleOf("done")).toBe("plain");
  });
});

describe("sessionUrl", () => {
  it("points at the session page, reaching a wildcard bind on loopback", () => {
    expect(sessionUrl("abc", "127.0.0.1", 4477)).toBe("http://127.0.0.1:4477/session/abc");
    expect(sessionUrl("abc", "0.0.0.0", 4477)).toBe("http://127.0.0.1:4477/session/abc");
    expect(sessionUrl("a/b", "::1", 1)).toBe("http://[::1]:1/session/a%2Fb");
  });
});
