/**
 * `agent-lens browse` without a terminal: text cleaning and wrapping, the screens, styling, and the
 * key reducer are pure functions (ADR-042). The terminal driver itself is exercised by hand in a pty.
 */
import { describe, it, expect } from "vitest";
import type { SessionDetail, SessionSummary, ToolCall } from "@agent-lens/contracts";
import { charWidth, clean, displayWidth, fit, wrap } from "../src/browse/text.js";
import {
  filterSessions,
  fmtSpan,
  highlight,
  nextMatch,
  reduce,
  renderHelp,
  renderList,
  renderPager,
  toolLine,
  transcriptLines,
  type Ctx,
  type Key,
  type ListState,
  type PagerState,
  type State,
} from "../src/browse/view.js";
import { detectTheme, drawLine, SELECTED_BG, useColor, type Line } from "../src/browse/style.js";
import { osc52, sessionUrl, subagentAt } from "../src/browse/index.js";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const txt = (l: Line) => l.map(([t]) => t).join("");
const LIST: ListState = { screen: "list", cursor: 0, top: 0, filter: "" };
const pagerOf = (o: Partial<PagerState> = {}): PagerState => ({
  screen: "pager", sessionId: "s1", top: 0, list: LIST, expanded: [], find: "", thinking: false, results: false, ...o,
});
/** Feed keys one at a time, returning the final state and every effect. */
function press(state: State, keys: Key[], ctx: Ctx): { state: State; effects: unknown[] } {
  const effects: unknown[] = [];
  for (const k of keys) {
    const r = reduce(state, k, ctx);
    state = r.state;
    if (r.effect) effects.push(r.effect);
  }
  return { state, effects };
}
const type = (s: string): Key[] => [...s].map((ch) => ({ sequence: ch, name: ch.toLowerCase() }));

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

describe("reduce: list", () => {
  const ctx: Ctx = { count: 10, height: 3 };

  it("moves the cursor and scrolls to keep it visible", () => {
    let s = press(LIST, Array(5).fill({ name: "down" }), ctx).state as ListState;
    expect(s).toMatchObject({ cursor: 5, top: 3 });
    s = reduce(s, { name: "g", sequence: "g" }, ctx).state as ListState;
    expect(s).toMatchObject({ cursor: 0, top: 0 });
    s = reduce(s, { name: "g", sequence: "G", shift: true }, ctx).state as ListState;
    expect(s.cursor).toBe(9);
    expect(reduce(LIST, { name: "up" }, ctx).state).toEqual(LIST);
  });

  it("opens the pager or the web UI, copies the id, and quits", () => {
    expect(reduce(LIST, { name: "return" }, ctx).effect).toEqual({ type: "open-pager" });
    expect(reduce(LIST, { name: "o", sequence: "o" }, ctx).effect).toEqual({ type: "open-web" });
    expect(reduce(LIST, { name: "y", sequence: "y" }, ctx).effect).toEqual({ type: "copy" });
    expect(reduce(LIST, { name: "q", sequence: "q" }, ctx).effect).toEqual({ type: "quit" });
    expect(reduce(LIST, { name: "c", ctrl: true }, ctx).effect).toEqual({ type: "quit" });
    expect(reduce(LIST, { name: "return" }, { count: 0, height: 3 }).effect).toBeNull();
  });

  it("filters as you type after /, keeps it on enter, and clears it on escape", () => {
    let s = press(LIST, [{ sequence: "/" }, ...type("api")], ctx).state as ListState;
    expect(s).toMatchObject({ prompt: "api", filter: "api", cursor: 0 });
    s = reduce(s, { name: "backspace" }, ctx).state as ListState;
    expect(s.filter).toBe("ap");
    s = reduce(s, { name: "return" }, ctx).state as ListState;
    expect(s).toMatchObject({ prompt: undefined, filter: "ap" });
    // A typed "q" is text, not quit, while the prompt is open.
    expect(press(LIST, [{ sequence: "/" }, { name: "q", sequence: "q" }], ctx).effects).toEqual([]);
    expect((reduce(s, { name: "escape" }, ctx).state as ListState).filter).toBe("");
  });

  it("shows help on ?, and any key closes it", () => {
    const s = reduce(LIST, { sequence: "?" }, ctx).state;
    expect(s.help).toBe(true);
    const closed = reduce(s, { name: "q", sequence: "q" }, ctx);
    expect(closed.state.help).toBe(false);
    expect(closed.effect).toBeNull(); // closing help doesn't also quit
  });
});

describe("reduce: pager", () => {
  const texts = ["header", "", "── turn 1", "you:", "  fix the bug", "claude:", "  done", "", "── turn 2", "you:", "  fix the other bug", "claude:", "  ok"];
  const ctx: Ctx = { count: texts.length, height: 4, texts, turns: [2, 8] };

  it("scrolls within bounds and goes back to the list as it was left", () => {
    const left: ListState = { ...LIST, cursor: 4, top: 2 };
    const p = pagerOf({ list: left });
    expect((reduce(p, { name: "space" }, ctx).state as PagerState).top).toBe(3);
    expect((reduce(p, { name: "end" }, ctx).state as PagerState).top).toBe(9);
    expect((reduce(p, { name: "up" }, ctx).state as PagerState).top).toBe(0);
    expect(reduce(p, { name: "q", sequence: "q" }, ctx).state).toEqual(left);
  });

  it("jumps between turns with [ and ]", () => {
    let s = reduce(pagerOf(), { sequence: "]" }, ctx).state as PagerState;
    expect(s.top).toBe(2);
    s = reduce(s, { sequence: "]" }, ctx).state as PagerState;
    expect(s.top).toBe(8);
    expect((reduce(s, { sequence: "]" }, ctx).state as PagerState).top).toBe(8); // no further turn
    expect((reduce(s, { sequence: "[" }, ctx).state as PagerState).top).toBe(2);
  });

  it("finds text after /, steps with n and N, and clears it on escape", () => {
    let s = press(pagerOf(), [{ sequence: "/" }, ...type("BUG"), { name: "return" }], ctx).state as PagerState;
    expect(s).toMatchObject({ find: "BUG", top: 4, prompt: undefined });
    s = reduce(s, { sequence: "n" }, ctx).state as PagerState;
    expect(s.top).toBe(10);
    const end = reduce(s, { sequence: "n" }, ctx);
    expect(end.effect).toEqual({ type: "message", text: 'No more matches for "BUG"' });
    s = reduce(s, { sequence: "N", shift: true }, ctx).state as PagerState;
    expect(s.top).toBe(4);
    s = reduce(s, { name: "escape" }, ctx).state as PagerState;
    expect(s).toMatchObject({ screen: "pager", find: "" }); // the first escape only clears the find
  });

  it("says so when nothing matches", () => {
    const r = press(pagerOf(), [{ sequence: "/" }, ...type("zzz"), { name: "return" }], ctx);
    expect(r.effects).toEqual([{ type: "message", text: 'No match for "zzz"' }]);
    expect((r.state as PagerState).top).toBe(0);
  });

  it("toggles thinking and results, and asks to open a subagent or copy", () => {
    const p = pagerOf();
    expect((reduce(p, { name: "t", sequence: "t" }, ctx).state as PagerState).thinking).toBe(true);
    expect((reduce(p, { name: "r", sequence: "r" }, ctx).state as PagerState).results).toBe(true);
    expect(reduce(p, { name: "s", sequence: "s" }, ctx).effect).toEqual({ type: "open-subagent" });
    expect(reduce(p, { name: "y", sequence: "y" }, ctx).effect).toEqual({ type: "copy" });
  });

  it("goes back from a subagent's transcript to its parent's, then to the list", () => {
    const parent = pagerOf({ top: 7 });
    const child = pagerOf({ sessionId: "agent-x", parent });
    const back = reduce(child, { name: "q", sequence: "q" }, ctx).state;
    expect(back).toEqual(parent);
    expect(reduce(back, { name: "q", sequence: "q" }, ctx).state).toEqual(LIST);
  });
});

describe("reduce: items", () => {
  const items = [
    { key: "m1", kind: "message" as const, start: 3, end: 4, expandable: false, search: "l3 l4" },
    { key: "t1", kind: "tool" as const, start: 5, end: 5, expandable: true, subagent: "agent-1", search: "bash\nsecret output" },
    { key: "m2", kind: "message" as const, start: 9, end: 20, expandable: true, search: "m2" },
    { key: "t2", kind: "tool" as const, start: 22, end: 22, expandable: true, search: "t2" },
  ];
  const texts = Array.from({ length: 24 }, (_, i) => (i === 21 ? "a needle here" : `l${i}`));
  const ctx: Ctx = { count: 24, height: 6, texts, turns: [2, 8], items };

  it("moves the selection between items and scrolls just enough to show each", () => {
    let s = reduce(pagerOf(), { name: "down" }, ctx).state as PagerState;
    expect(s).toMatchObject({ sel: "t1", top: 0 });
    s = reduce(s, { name: "down" }, ctx).state as PagerState;
    expect(s).toMatchObject({ sel: "m2", top: 9 }); // taller than the screen: its start goes on top
    s = reduce(s, { name: "down" }, ctx).state as PagerState;
    expect(s).toMatchObject({ sel: "t2", top: 17 });
    expect((reduce(s, { name: "down" }, ctx).state as PagerState).sel).toBe("t2"); // the last stays
    expect((reduce(s, { name: "up" }, ctx).state as PagerState).sel).toBe("m2");
    expect(reduce(s, { name: "g", sequence: "g" }, ctx).state).toMatchObject({ sel: "m1", top: 0 });
  });

  it("expands and collapses the selected item with enter, and ignores one that can't expand", () => {
    const on = reduce(pagerOf({ sel: "t1" }), { name: "return" }, ctx).state as PagerState;
    expect(on.expanded).toEqual(["t1"]);
    expect((reduce(on, { name: "return" }, ctx).state as PagerState).expanded).toEqual([]);
    expect((reduce(pagerOf({ sel: "m1" }), { name: "return" }, ctx).state as PagerState).expanded).toEqual([]);
  });

  it("selects what a page, a turn jump or a find lands on", () => {
    expect(reduce(pagerOf(), { name: "space" }, ctx).state).toMatchObject({ top: 5, sel: "t1" });
    expect(reduce(pagerOf(), { sequence: "]" }, ctx).state).toMatchObject({ top: 2, sel: "m1" });
    const found = press(pagerOf(), [{ sequence: "/" }, ...type("needle"), { name: "return" }], ctx).state;
    expect(found).toMatchObject({ top: 21, find: "needle" });
  });

  it("finds text a collapsed tool call hides, and opens it", () => {
    const r = press(pagerOf(), [{ sequence: "/" }, ...type("secret"), { name: "return" }], ctx).state as PagerState;
    expect(r).toMatchObject({ top: 5, sel: "t1", expanded: ["t1"], find: "secret" });
  });
});

const session = (id: string, title: string, project = "/w/demo"): SessionSummary =>
  ({ id, title, started_at: null, project_path: project, cost: 1.5, unpriced_models: [] }) as unknown as SessionSummary;

describe("helpers", () => {
  it("nextMatch searches shown lines forward and back, any case", () => {
    const ctx: Ctx = { count: 3, height: 3, texts: ["Alpha", "beta", "ALPHA"], items: [] };
    expect(nextMatch(ctx, "alpha", 0, 1)).toEqual({ line: 2 });
    expect(nextMatch(ctx, "alpha", 0, 1, true)).toEqual({ line: 0 });
    expect(nextMatch(ctx, "alpha", 2, -1)).toEqual({ line: 0 });
    expect(nextMatch(ctx, "gamma", 0, 1)).toBeNull();
    expect(nextMatch(ctx, "", 0, 1)).toBeNull();
  });

  it("filterSessions matches title, project or id", () => {
    const all = [session("a1", "Fix login", "/w/web"), session("b2", "Docs", "/w/api"), session("c3-xyz", "Other")];
    expect(filterSessions(all, "LOGIN").map((s) => s.id)).toEqual(["a1"]);
    expect(filterSessions(all, "api").map((s) => s.id)).toEqual(["b2"]);
    expect(filterSessions(all, "xyz").map((s) => s.id)).toEqual(["c3-xyz"]);
    expect(filterSessions(all, " ")).toHaveLength(3);
  });

  it("highlight marks every match across spans, any case", () => {
    expect(highlight([["a Bug and a bug", "plain"]], "bug")).toEqual([
      ["a ", "plain"], ["Bug", "match"], [" and a ", "plain"], ["bug", "match"],
    ]);
    expect(highlight([["x"]], "")).toEqual([["x"]]);
  });

  it("subagentAt picks the first [s] call on screen, else the next below", () => {
    const t = { lines: [], turns: [], items: [], subagents: [{ line: 3, sessionId: "agent-a" }, { line: 30, sessionId: "agent-b" }] };
    expect(subagentAt(t, 0, 10)).toBe("agent-a");
    expect(subagentAt(t, 5, 10)).toBe("agent-b");
    expect(subagentAt(t, 31, 10)).toBeNull();
  });

  it("fmtSpan reads as seconds, minutes or hours", () => {
    expect(fmtSpan(45_000)).toBe("45s");
    expect(fmtSpan(200_000)).toBe("3m 20s");
    expect(fmtSpan(3_900_000)).toBe("1h 05m");
  });

  it("osc52 base64-encodes the text for the clipboard", () => {
    expect(osc52("abc")).toBe("\x1b]52;c;YWJj\x07");
  });

  it("sessionUrl points at the session page, reaching a wildcard bind on loopback", () => {
    expect(sessionUrl("abc", "127.0.0.1", 4477)).toBe("http://127.0.0.1:4477/session/abc");
    expect(sessionUrl("abc", "0.0.0.0", 4477)).toBe("http://127.0.0.1:4477/session/abc");
    expect(sessionUrl("a/b", "::1", 1)).toBe("http://[::1]:1/session/a%2Fb");
  });
});

describe("screens", () => {
  it("renderList draws exactly the terminal's size, the selected row inverted", () => {
    const rows = [session("a", "first"), session("b", "second")];
    const out = renderList(rows, { ...LIST, cursor: 1 }, 80, 6);
    expect(out).toHaveLength(6);
    for (const l of out) expect(displayWidth(plain(l))).toBe(80);
    expect(out[2].startsWith("\x1b[7m")).toBe(true);
    expect(plain(out[2])).toContain("second");
    expect(plain(out[5])).toContain("? help");
  });

  it("renderList shows source and turns, not cost", () => {
    const row = { ...session("a", "first"), source_id: "team-a", turn_count: 7 } as SessionSummary;
    const out = renderList([row], LIST, 100, 4).map(plain);
    expect(out[0]).toMatch(/source +project +turns$/);
    expect(out[1]).toMatch(/team-a +demo +7$/);
    expect(out.join("\n")).not.toContain("$1.50");
  });

  it("renderList shows the filter and the prompt being typed", () => {
    const rows = [session("a", "first")];
    expect(plain(renderList(rows, { ...LIST, filter: "fi" }, 70, 5, "", false, 9)[0])).toContain("Sessions (1 of 9)  filter: fi");
    expect(plain(renderList(rows, { ...LIST, filter: "fi", prompt: "fi" }, 70, 5)[4])).toMatch(/^\/fi█ +enter keep · esc clear/);
  });

  it("renderPager shows a window of the transcript, highlights the find, and says where it is", () => {
    const lines: Line[] = Array.from({ length: 30 }, (_, i) => [[`line ${i + 1}`]]);
    const t = { lines, turns: [], subagents: [], items: [{ key: "a", kind: "message" as const, start: 6, end: 7, expandable: false, search: "" }] };
    const out = renderPager("Title", t, pagerOf({ top: 5, sel: "a" }), 80, 6);
    expect(out.map((l) => plain(l).trimEnd())).toEqual([
      "Title", "  line 6", "▌ line 7", "▌ line 8", "  line 9", expect.stringMatching(/^6–9 of 30 · ↑↓ item · \[ \] turns/),
    ]);
    const found = renderPager("T", t, pagerOf({ top: 5, find: "line 7" }), 80, 6);
    expect(found[2]).toContain("\x1b[7mline 7\x1b[0m"); // inverted even without colour
    expect(plain(found[5])).toContain('"line 7": n next');
  });

  it("renderHelp lists the keys for the screen and fits it", () => {
    const out = renderHelp("pager", 70, 18, false).map((l) => l.trimEnd());
    expect(out).toHaveLength(18);
    expect(out.some((l) => /\[ \] +previous, next turn/.test(l))).toBe(true);
    expect(out.at(-1)).toBe("any key closes");
  });

  it("toolLine names the call, then its markers, then what it acted on", () => {
    const t = (o: Partial<ToolCall>): ToolCall => ({ tool_name: "Bash", input_json: null, status: null, skill_name: null, agent_type: null, ...o }) as ToolCall;
    expect(txt(toolLine(t({ input_json: JSON.stringify({ command: "pnpm test\nmore" }) })))).toBe("▸ Bash: pnpm test");
    expect(txt(toolLine(t({ input_json: '{"command":"ls"}' }), true))).toBe("▾ Bash: ls");
    expect(txt(toolLine(t({ tool_name: "Edit", input_json: '{"file_path":"src/a.ts"}', status: "error" })))).toBe("▸ Edit (failed): src/a.ts");
    expect(txt(toolLine(t({ tool_name: "Task", agent_type: "Explore", spawned_session_id: "agent-1", input_json: "x" })))).toBe("▸ Task → Explore [s]");
    const flagged = toolLine(t({ input_json: '{"command":"rm -rf /"}', findings: [{ severity: "critical", rule_id: "destructive.rm_rf" }] as never }));
    expect(txt(flagged)).toBe("▸ Bash ● critical destructive.rm_rf: rm -rf /");
    expect(flagged).toContainEqual([" ● critical destructive.rm_rf", "critical"]);
  });
});

describe("transcriptLines", () => {
  const d = {
    session: { started_at: null, project_path: "/w", cost: 0 },
    turns: [{}, {}],
    events: [
      { role: "user", type: "user", turn_id: "t0", text: "fix it\x1b[2J", thinking: null, toolCalls: [] },
      {
        role: "assistant", type: "assistant", turn_id: "t0", text: null, thinking: "let me look",
        toolCalls: [
          { tool_name: "Bash", input_json: '{"command":"ls"}', result_summary: "a.ts\nb.ts" },
          { tool_name: "Task", agent_type: "Explore", spawned_session_id: "agent-9", input_json: "{}" },
        ],
      },
      { role: "assistant", type: "assistant", turn_id: "t0", text: "## Plan\n```\nls\n```\ndone", thinking: null, toolCalls: [] },
      { role: "user", type: "user", turn_id: "t1", text: "thanks", thinking: null, toolCalls: [] },
    ],
  } as unknown as SessionDetail;

  it("labels each speaker once per run, puts tool calls under claude, and passes no escapes through", () => {
    const out = transcriptLines(d, 40).lines.map(txt);
    const head = out.findIndex((l) => l.startsWith("╭─ claude"));
    expect(out.filter((l) => l.startsWith("╭─ claude"))).toHaveLength(1);
    expect(out.slice(head + 1, head + 3)).toEqual(["│ ▸ Bash: ls", "│ ▸ Task → Explore [s]"]);
    expect(out.join("\n")).not.toContain("\x1b");
  });

  it("draws each speaker's run as a card: a titled top border, a bar, and a closing corner", () => {
    const lines = transcriptLines(d, 40).lines;
    const out = lines.map(txt);
    const tops = out.filter((l) => l.startsWith("╭─ "));
    expect(tops.map((l) => l.split(" ")[1])).toEqual(["you", "claude", "you"]);
    expect(out.filter((l) => l === "╰─")).toHaveLength(3);
    for (const l of tops) expect(l.length).toBe(40); // the border fills the width
    const youTop = lines.find((l) => txt(l).startsWith("╭─ you"))!;
    expect(youTop[0][1]).toBe("youBar");
    const claudeBody = lines.find((l) => txt(l) === "│ ▸ Bash: ls")!;
    expect(claudeBody[0]).toEqual(["│ ", "claudeBar"]);
  });

  it("opens each turn with a band carrying its time and duration", () => {
    const timed = { ...d, turns: [{ id: "t0", started_at: "2026-03-10T09:01:00.000Z", duration_ms: 200_000 }, { id: "t1" }] } as unknown as SessionDetail;
    const t = transcriptLines(timed, 50);
    const band = txt(t.lines[t.turns[0]]);
    expect(band).toMatch(/^━━ Turn 1 · \d\d:\d\d · 3m 20s ━+$/);
    expect(band.length).toBe(50);
  });

  it("records where each turn starts and which line spawned a subagent", () => {
    const t = transcriptLines(d, 40);
    expect(t.turns.map((i) => txt(t.lines[i]).slice(0, 9))).toEqual(["━━ Turn 1", "━━ Turn 2"]);
    expect(t.subagents).toHaveLength(1);
    expect(txt(t.lines[t.subagents[0].line])).toContain("Task → Explore");
    expect(t.subagents[0].sessionId).toBe("agent-9");
  });

  it("renders messages as markdown: a heading without its hashes, code without its fences", () => {
    const lines = transcriptLines(d, 40).lines;
    const styleOf = (text: string) => lines.find((l) => txt(l).trim() === text)?.at(-1)?.[1];
    expect(styleOf("│ Plan")).toBe("heading");
    expect(styleOf("│ │ ls")).toBe("code");
    expect(styleOf("│ done")).toBe("plain");
    expect(lines.map(txt).join("\n")).not.toMatch(/##|```/);
  });

  it("lists each message, thinking block and tool call as an item spanning its lines", () => {
    const t = transcriptLines(d, 40, { thinking: true });
    expect(t.items.map((i) => i.kind)).toEqual(["message", "thinking", "tool", "tool", "message", "message"]);
    for (const it of t.items) expect(it.end).toBeGreaterThanOrEqual(it.start);
    const task = t.items.find((i) => i.subagent);
    expect(task?.subagent).toBe("agent-9");
    expect(txt(t.lines[task!.start])).toContain("Task → Explore");
  });

  it("expands one tool call by key, or every one with results", () => {
    const key = transcriptLines(d, 40).items.find((i) => i.kind === "tool")!.key;
    const one = transcriptLines(d, 40, { expanded: [key] }).lines.map(txt);
    expect(one).toContain("│ ▾ Bash: ls");
    expect(one).toContain("│   $ ls");
    expect(one).toContain("│   │ a.ts");
    expect(one).toContain("│ ▸ Task → Explore [s]");
  });

  it("cuts a long message to its first lines until it is expanded", () => {
    const long = { ...d, events: [{ role: "assistant", type: "assistant", turn_id: "t0", uuid: "m1", text: Array.from({ length: 30 }, (_, i) => `para ${i}`).join("\n\n"), thinking: null, toolCalls: [] }] } as unknown as SessionDetail;
    const cut = transcriptLines(long, 40);
    const item = cut.items[0];
    expect(item.expandable).toBe(true);
    expect(txt(cut.lines[item.end])).toMatch(/^│ … \d+ more lines · enter shows all$/);
    const full = transcriptLines(long, 40, { expanded: [item.key] });
    expect(full.lines.map(txt)).toContain("│ para 29");
    // A find reaches the hidden lines through the item's search text.
    expect(item.search).toContain("para 29");
  });

  it("shows thinking and tool results only when asked", () => {
    const hidden = transcriptLines(d, 40).lines.map(txt).join("\n");
    expect(hidden).not.toContain("let me look");
    expect(hidden).not.toContain("a.ts");
    const shown = transcriptLines(d, 40, { thinking: true, results: true }).lines;
    const text = shown.map(txt);
    expect(text).toContain("│ ┆ let me look");
    expect(text).toContain("│   │ a.ts");
    expect(text).toContain("│   $ ls");
    expect(shown.find((l) => txt(l) === "│ ┆ let me look")?.at(-1)?.[1]).toBe("thinking");
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
    expect(out).toContain("\x1b[0m\x1b[7m");
    expect(drawLine([["a"]], 2, false, "7")).toBe("\x1b[7ma \x1b[0m");
  });

  it("detects a light or dark background, and lets AGENT_LENS_THEME decide", () => {
    expect(detectTheme({})).toBe("dark");
    expect(detectTheme({ COLORFGBG: "15;0" })).toBe("dark");
    expect(detectTheme({ COLORFGBG: "0;15" })).toBe("light");
    expect(detectTheme({ COLORFGBG: "0;default;7" })).toBe("light");
    expect(detectTheme({ COLORFGBG: "0;15", AGENT_LENS_THEME: "dark" })).toBe("dark");
    expect(detectTheme({ AGENT_LENS_THEME: "LIGHT" })).toBe("light");
    expect(detectTheme({ AGENT_LENS_THEME: "neon" })).toBe("dark");
  });

  it("tints the selected item and row with colour on, and bars or inverts them without", () => {
    const lines: Line[] = Array.from({ length: 4 }, (_, i) => [[`line ${i}`]]);
    const t = { lines, turns: [], subagents: [], items: [{ key: "a", kind: "message" as const, start: 1, end: 2, expandable: false, search: "" }] };
    const lightTint = `\x1b[${SELECTED_BG.light}m`;
    const tinted = renderPager("T", t, pagerOf({ sel: "a" }), 30, 6, "", true, "light");
    expect(tinted[2].startsWith(lightTint)).toBe(true);
    expect(tinted[3].startsWith(lightTint)).toBe(true);
    expect(tinted[1]).not.toContain(lightTint);
    expect(plain(tinted[2])).toBe("  line 1".padEnd(30)); // no bar when tinted
    expect(plain(renderPager("T", t, pagerOf({ sel: "a" }), 30, 6)[2])).toBe("▌ line 1".padEnd(30));
    const rows = [session("a", "first"), session("b", "second")];
    expect(renderList(rows, LIST, 80, 5, "", true, 2, "dark")[1].startsWith(`\x1b[${SELECTED_BG.dark}m`)).toBe(true);
    expect(renderList(rows, LIST, 80, 5)[1].startsWith("\x1b[7m")).toBe(true);
  });

  it("colours a TTY unless NO_COLOR is set", () => {
    expect(useColor({}, true)).toBe(true);
    expect(useColor({ NO_COLOR: "1" }, true)).toBe(false);
    expect(useColor({}, false)).toBe(false);
  });
});
