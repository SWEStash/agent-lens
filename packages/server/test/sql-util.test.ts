/**
 * Shared SQL helpers. `orderBy` is the one place a request-supplied value reaches the SQL text
 * (SQLite can't parameterize an ORDER BY expression), so its allowlisting is worth pinning directly
 * rather than only through the endpoints that use it. Imports the BUILT dist.
 */
import { describe, it, expect } from "vitest";
import { orderBy, pushGrouped } from "../dist/sql-util.js";

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
