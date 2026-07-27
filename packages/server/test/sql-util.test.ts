/**
 * Shared SQL helpers. `orderBy` is the one place a request-supplied value reaches the SQL text
 * (SQLite can't parameterize an ORDER BY expression), so its allowlisting is worth pinning directly
 * rather than only through the endpoints that use it. Imports the BUILT dist.
 */
import { describe, it, expect } from "vitest";
import { orderBy, pageLimit, pageOffset, pushGrouped } from "../dist/sql-util.js";

const COLUMNS = { started: "s.started_at", title: "COALESCE(s.ai_title, s.slug)", turns: "s.turn_count" };

describe("orderBy", () => {
  it("resolves a known sort key to its column expression", () => {
    expect(orderBy(COLUMNS, "turns", "started", "asc")).toBe("s.turn_count ASC");
  });

  it("falls back for an unknown key instead of interpolating it", () => {
    expect(orderBy(COLUMNS, "s.id; DROP TABLE sessions--", "started", "desc")).toBe("s.started_at DESC");
  });

  it("falls back for an absent key", () => {
    expect(orderBy(COLUMNS, undefined, "title")).toBe("COALESCE(s.ai_title, s.slug) DESC");
  });

  it("never emits an inherited Object property as a column", () => {
    expect(orderBy(COLUMNS, "toString", "started", "asc")).toBe("s.started_at ASC");
    expect(orderBy(COLUMNS, "__proto__", "started", "asc")).toBe("s.started_at ASC");
  });

  it("collapses the direction to one of two literals", () => {
    expect(orderBy(COLUMNS, "turns", "started", "ASC")).toBe("s.turn_count DESC"); // only lowercase "asc" ascends
    expect(orderBy(COLUMNS, "turns", "started", "; --")).toBe("s.turn_count DESC");
    expect(orderBy(COLUMNS, "turns", "started")).toBe("s.turn_count DESC");
  });
});

describe("pushGrouped", () => {
  it("creates the list on first use and appends after", () => {
    const m = new Map<string, number[]>();
    pushGrouped(m, "a", 1);
    pushGrouped(m, "a", 2);
    pushGrouped(m, "b", 3);
    expect(m.get("a")).toEqual([1, 2]);
    expect(m.get("b")).toEqual([3]);
  });
});

// Pagination bounds. Both of these replaced an idiom that guarded only the upper bound
// (`Math.min(Number(x) || d, max)` / `Number(x) || 0`), which let a negative limit disable the cap
// entirely and let a non-integer offset reach — and crash — the SQLite driver.
describe("pageLimit", () => {
  it("honours a valid limit and clamps an oversized one", () => {
    expect(pageLimit("7", 50, 200)).toBe(7);
    expect(pageLimit("200", 50, 200)).toBe(200);
    expect(pageLimit("999999", 50, 200)).toBe(200);
  });

  it("falls back to the default for anything not a usable count", () => {
    for (const raw of [undefined, null, "", "abc", "0", "-1", "-999", NaN, Infinity, -Infinity]) {
      expect(pageLimit(raw, 50, 200), String(raw)).toBe(50);
    }
  });

  it("never exceeds max, even via the fallback", () => {
    expect(pageLimit("abc", 500, 200)).toBe(200);
  });

  it("floors a fractional limit rather than passing a float to the driver", () => {
    expect(pageLimit("7.9", 50, 200)).toBe(7);
    // Floors below 1 → not a usable count → default.
    expect(pageLimit("0.5", 50, 200)).toBe(50);
  });
});

describe("pageOffset", () => {
  it("passes a valid offset through", () => {
    expect(pageOffset("0")).toBe(0);
    expect(pageOffset("250")).toBe(250);
  });

  it("floors a fractional offset (the ?offset=1.5 500)", () => {
    expect(pageOffset("1.5")).toBe(1);
    expect(pageOffset("2.7")).toBe(2);
    expect(Number.isInteger(pageOffset("1.5"))).toBe(true);
  });

  it("collapses negative and non-numeric input to 0", () => {
    for (const raw of [undefined, null, "", "abc", "-1", "-0.5", NaN, Infinity, -Infinity]) {
      expect(pageOffset(raw), String(raw)).toBe(0);
    }
  });
});
