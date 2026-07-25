/**
 * Line-level LCS diff (transcript/diff.ts) — the basis for rendering an Edit/MultiEdit/Write tool call
 * as a +/- diff. Pins the LCS tie-breaking (which decides whether a change reads as del-then-add) and
 * the large-input bail-out, both previously untested. Imports SOURCE (web has no per-module dist).
 */
import { describe, it, expect } from "vitest";
import { diffLines } from "../src/transcript/diff";

/** Compact "±text" rendering so expectations read like a diff. */
const sign = { ctx: " ", add: "+", del: "-" } as const;
const render = (a: string, b: string) => diffLines(a, b).map((l) => sign[l.type] + l.text);

describe("diffLines", () => {
  it("returns nothing for two empty strings", () => {
    expect(diffLines("", "")).toEqual([]);
  });

  it("marks every line as context when the strings are identical", () => {
    expect(render("a\nb", "a\nb")).toEqual([" a", " b"]);
  });

  it("treats an empty string as zero lines, not one blank line", () => {
    expect(render("", "x")).toEqual(["+x"]);
    expect(render("x", "")).toEqual(["-x"]);
  });

  it("preserves genuinely blank lines inside a non-empty string", () => {
    expect(render("\n", "\n")).toEqual([" ", " "]);
  });

  it("reports a replaced line as a delete followed by an add, keeping context", () => {
    expect(render("a\nb\nc", "a\nx\nc")).toEqual([" a", "-b", "+x", " c"]);
  });

  it("reports pure appends as adds only", () => {
    expect(render("a", "a\nb\nc")).toEqual([" a", "+b", "+c"]);
  });

  it("reports pure removals as deletes only", () => {
    expect(render("a\nb\nc", "a")).toEqual([" a", "-b", "-c"]);
  });

  it("finds the common subsequence across an insertion in the middle", () => {
    expect(render("a\nc", "a\nb\nc")).toEqual([" a", "+b", " c"]);
  });

  it("handles a complete rewrite with no common lines", () => {
    expect(render("a\nb", "x\ny")).toEqual(["-a", "-b", "+x", "+y"]);
  });

  it("keeps the first of a repeated line as context and deletes the surplus", () => {
    expect(render("a\na\nb", "a\nb")).toEqual([" a", "-a", " b"]);
  });

  it("falls back to delete-all + add-all when the LCS table would be too large", () => {
    // The guard trips at n * m > 250_000; 501 x 501 = 251_001.
    const a = Array.from({ length: 501 }, (_, i) => "a" + i).join("\n");
    const b = Array.from({ length: 501 }, (_, i) => "a" + i).join("\n");
    const out = diffLines(a, b);
    expect(out).toHaveLength(1002);
    expect(out.every((l, i) => l.type === (i < 501 ? "del" : "add"))).toBe(true);
  });

  it("still runs the real LCS just under the guard", () => {
    // 500 x 500 = 250_000, which is not > 250_000 — identical input stays all-context.
    const a = Array.from({ length: 500 }, (_, i) => "a" + i).join("\n");
    expect(diffLines(a, a).every((l) => l.type === "ctx")).toBe(true);
  });
});
