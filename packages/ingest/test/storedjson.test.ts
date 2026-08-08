/**
 * Stored-JSON parsing. A corrupt `tool_calls.input_json` row must not abort a derivation
 * pass, but it must not vanish silently either — the affected tool call simply stops producing
 * findings/LoC, which is indistinguishable from "nothing to report" without a counter.
 * Imports the BUILT dist.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { parseStored, malformedStoredJson, resetMalformedStoredJson } from "../dist/storedjson.js";

beforeEach(() => {
  resetMalformedStoredJson();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseStored", () => {
  it("parses valid JSON and counts nothing", () => {
    expect(parseStored<{ a: number }>('{"a":1}', "test")).toEqual({ a: 1 });
    expect(malformedStoredJson()).toBe(0);
  });

  it("treats null/empty as absent, not as a failure", () => {
    expect(parseStored(null, "test")).toBe(null);
    expect(parseStored("", "test")).toBe(null);
    expect(malformedStoredJson()).toBe(0);
  });

  it("returns null and counts a corrupt row instead of throwing", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseStored("{truncated", "test")).toBe(null);
    expect(malformedStoredJson()).toBe(1);
  });

  it("warns once per call site, however many rows are corrupt", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseStored("{a", "site-a");
    parseStored("{b", "site-a");
    parseStored("{c", "site-b");
    expect(malformedStoredJson()).toBe(3);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
