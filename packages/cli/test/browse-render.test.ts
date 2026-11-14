/**
 * Markdown and tool-call rendering for `agent-lens browse`: what a message or an expanded tool call
 * looks like in the terminal, as styled lines.
 */
import { describe, it, expect } from "vitest";
import type { ToolCall } from "@agent-lens/contracts";
import { inline, markdownLines, wrapSpans } from "../src/browse/markdown.js";
import { MAX_OUTPUT_LINES, toolDetailLines } from "../src/browse/tools.js";
import { displayWidth } from "../src/browse/text.js";
import type { Line } from "../src/browse/style.js";

const txt = (l: Line) => l.map(([t]) => t).join("");

describe("inline markdown", () => {
  it("turns emphasis, code and links into styled spans without their markers", () => {
    expect(inline("a **bold** b *it* c `x()` d [docs](https://e.x) e")).toEqual([
      ["a ", "plain"], ["bold", "bold"], [" b ", "plain"], ["it", "italic"], [" c ", "plain"], ["x()", "code"],
      [" d ", "plain"], ["docs", "link"], [" (https://e.x)", "dim"], [" e", "plain"],
    ]);
  });

  it("leaves snake_case, arithmetic and lone markers alone", () => {
    for (const s of ["call my_var_name now", "2*3*4", "a * b", "price: $5 * 2"]) expect(inline(s)).toEqual([[s, "plain"]]);
  });

  it("keeps a heading's bold as the heading style, and a bare link once", () => {
    expect(inline("the **plan**", "heading")).toEqual([["the ", "heading"], ["plan", "heading"]]);
    expect(inline("[https://a.b](https://a.b)")).toEqual([["https://a.b", "link"]]);
  });
});

describe("wrapSpans", () => {
  it("breaks at spaces and carries each span's style across the break", () => {
    const out = wrapSpans([["see ", "plain"], ["the very important", "bold"], [" part", "plain"]], 12);
    expect(out.map(txt)).toEqual(["see the very", "important", "part"]);
    expect(out[1]).toEqual([["important", "bold"]]);
    for (const l of out) expect(displayWidth(txt(l))).toBeLessThanOrEqual(12);
  });

  it("splits a word longer than the line", () => {
    expect(wrapSpans([["abcdefghij", "code"]], 4).map(txt)).toEqual(["abcd", "efgh", "ij"]);
  });
});

describe("markdown blocks", () => {
  const md = (s: string, w = 40) => markdownLines(s, w).map(txt);

  it("shows headings without hashes, in the heading style", () => {
    const out = markdownLines("## Next steps", 40);
    expect(out.map(txt)).toEqual(["Next steps"]);
    expect(out[0][0][1]).toBe("heading");
  });

  it("draws bullets and numbers with a hanging indent, and task boxes", () => {
    expect(md("- first item that is long enough to wrap around", 24)).toEqual(["• first item that is", "  long enough to wrap", "  around"]);
    expect(md("1. one\n2. two")).toEqual(["1. one", "2. two"]);
    expect(md("- [x] done\n- [ ] todo")).toEqual(["• ☑ done", "• ☐ todo"]);
    expect(md("  - nested")).toEqual(["  • nested"]);
  });

  it("drops code fences, keeping the language and the code's own lines", () => {
    const out = markdownLines("```ts\nconst a = 1;\n  return a;\n```\nafter", 40);
    expect(out.map(txt)).toEqual(["  ts", "│ const a = 1;", "│   return a;", "after"]);
    expect(out[1].at(-1)?.[1]).toBe("code");
  });

  it("draws quotes with a bar, rules as a line, and tables with separators", () => {
    expect(md("> careful here")).toEqual(["│ careful here"]);
    expect(md("---")[0]).toMatch(/^─+$/);
    expect(md("| name | b |\n|---|---|\n| x | 2 |")).toEqual(["name │ b", "────────", "x    │ 2"]);
    // Too wide to line up: each row wraps on its own instead.
    const wide = md("| a long first column | b |\n| x | y |", 14);
    expect(wide[0]).toBe("a long first");
    expect(wide).toContain("x │ y");
  });

  it("keeps one blank line between paragraphs", () => {
    expect(md("one\n\n\n\ntwo")).toEqual(["one", "", "two"]);
  });
});

describe("expanded tool calls", () => {
  const t = (o: Partial<ToolCall>): ToolCall =>
    ({ tool_name: "Bash", input_json: "{}", status: null, skill_name: null, agent_type: null, result_summary: null, ...o }) as ToolCall;

  it("shows a Bash command as $ lines under its description, then the output", () => {
    const out = toolDetailLines(t({ input_json: JSON.stringify({ command: "pnpm build\npnpm test", description: "Build and test" }), result_summary: "ok\n2 passed" }), 60).map(txt);
    expect(out).toEqual(["# Build and test", "$ pnpm build", "$ pnpm test", "│ ok", "│ 2 passed"]);
  });

  it("shows an edit as removed and added lines, and a write as added lines", () => {
    const edit = toolDetailLines(t({ tool_name: "Edit", input_json: JSON.stringify({ file_path: "src/a.ts", old_string: "a\nb", new_string: "c" }) }), 60);
    expect(edit.map(txt)).toEqual(["src/a.ts", "- a", "- b", "+ c"]);
    expect(edit[1][0][1]).toBe("removed");
    expect(edit[3][0][1]).toBe("added");
    const write = toolDetailLines(t({ tool_name: "Write", input_json: JSON.stringify({ file_path: "b.md", content: "x\ny" }) }), 60).map(txt);
    expect(write).toEqual(["b.md", "+ x", "+ y"]);
  });

  it("shows every edit of a MultiEdit, and any other tool's input as JSON", () => {
    const multi = toolDetailLines(t({ tool_name: "MultiEdit", input_json: JSON.stringify({ file_path: "f", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] }) }), 60).map(txt);
    expect(multi).toEqual(["f", "- a", "+ b", "  ⋯", "- c", "+ d"]);
    const grep = toolDetailLines(t({ tool_name: "Grep", input_json: JSON.stringify({ pattern: "TODO" }) }), 60).map(txt);
    expect(grep).toEqual(["{", '  "pattern": "TODO"', "}"]);
  });

  it("prefers the full spilled output, marks a failure, and caps a huge output", () => {
    const full = toolDetailLines(t({ input_json: '{"command":"x"}', result_summary: "Output too large", full_result: { text: "all of it", bytes: 9 } }), 60).map(txt);
    expect(full).toContain("│ all of it");
    expect(full).not.toContain("│ Output too large");
    const failed = toolDetailLines(t({ input_json: '{"command":"x"}', status: "error", result_summary: "boom" }), 60);
    expect(failed.at(-1)?.at(-1)?.[1]).toBe("error");
    const huge = toolDetailLines(t({ input_json: '{"command":"x"}', result_summary: Array.from({ length: 400 }, (_, i) => `l${i}`).join("\n") }), 60).map(txt);
    expect(huge).toHaveLength(1 + MAX_OUTPUT_LINES + 1);
    expect(huge.at(-1)).toBe("│ … 100 more lines; o opens the web UI");
  });

  it("strips escape sequences from input and output", () => {
    const out = toolDetailLines(t({ input_json: JSON.stringify({ command: "echo \u001b[2Jhi" }), result_summary: "\u001b]0;x\u0007done" }), 60).map(txt).join("\n");
    expect(out).not.toContain("\u001b");
  });
});
