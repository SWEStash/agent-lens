import { describe, it, expect } from "vitest";
import { countLines } from "../dist/lines.js";

describe("countLines", () => {
  it("counts lines git's way: a trailing newline adds no line", () => {
    expect(countLines("a")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\n\n")).toBe(2);
  });

  it("is 0 for empty input and non-strings", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("\n")).toBe(0);
    expect(countLines(undefined)).toBe(0);
    expect(countLines(42)).toBe(0);
  });
});
