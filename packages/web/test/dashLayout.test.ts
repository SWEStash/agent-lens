/**
 * Dashboard layout rules. These are the parts that outlive any one release: a stored layout has to keep
 * working when the chart/KPI registries gain and lose entries, and an upgrading user's pre-layout
 * `dashboard.charts` choice has to survive the move to the layout blob.
 */
import { describe, expect, it } from "vitest";
import { arrange, arrangeIds, emptyLayout, moveInOrder, normalizeLayout, toggleHidden } from "../src/dashboard/layout";

const REG = ["a", "b", "c"];

describe("normalizeLayout", () => {
  it("returns defaults for null, garbage and non-objects", () => {
    for (const raw of [null, undefined, 42, "nope", []]) {
      expect(normalizeLayout(raw)).toEqual(emptyLayout());
    }
  });

  it("fills in missing halves of a partial layout", () => {
    expect(normalizeLayout({ v: 1, charts: { hidden: ["a"] } })).toEqual({
      v: 1,
      kpis: { hidden: [], order: [] },
      charts: { hidden: ["a"], order: [] },
      kpisCollapsed: false,
    });
  });

  it("drops non-string entries instead of trusting the stored JSON", () => {
    const l = normalizeLayout({ kpis: { hidden: ["a", 3, null], order: "b" } });
    expect(l.kpis).toEqual({ hidden: ["a"], order: [] });
  });

  it("reads kpisCollapsed only when it is exactly true", () => {
    expect(normalizeLayout({ kpisCollapsed: true }).kpisCollapsed).toBe(true);
    expect(normalizeLayout({ kpisCollapsed: "yes" }).kpisCollapsed).toBe(false);
    expect(normalizeLayout({}).kpisCollapsed).toBe(false);
  });

  it("seeds the chart strip from the legacy dashboard.charts array when no layout is stored", () => {
    expect(normalizeLayout(null, ["cost-over-time"]).charts).toEqual({ hidden: ["cost-over-time"], order: [] });
  });

  it("ignores the legacy value once a layout exists", () => {
    expect(normalizeLayout({ charts: { hidden: [] } }, ["cost-over-time"]).charts.hidden).toEqual([]);
  });

  it("does not share array instances between calls", () => {
    const a = normalizeLayout(null);
    a.kpis.hidden.push("x");
    expect(normalizeLayout(null).kpis.hidden).toEqual([]);
  });
});

describe("arrangeIds", () => {
  it("uses registry order when nothing is stored", () => {
    expect(arrangeIds(REG, [])).toEqual(["a", "b", "c"]);
  });

  it("honours a full stored order", () => {
    expect(arrangeIds(REG, ["c", "a", "b"])).toEqual(["c", "a", "b"]);
  });

  it("appends registry entries the stored order does not mention", () => {
    // The upgrade case: "c" was added after the user saved this order.
    expect(arrangeIds(REG, ["b", "a"])).toEqual(["b", "a", "c"]);
  });

  it("drops ids that are no longer in the registry", () => {
    expect(arrangeIds(REG, ["gone", "c"])).toEqual(["c", "a", "b"]);
  });

  it("ignores duplicates in the stored order", () => {
    expect(arrangeIds(REG, ["b", "b"])).toEqual(["b", "a", "c"]);
  });
});

describe("arrange", () => {
  it("orders registry entries and keeps their objects", () => {
    const reg = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(arrange(reg, ["c"])).toEqual([{ id: "c" }, { id: "a" }, { id: "b" }]);
    expect(arrange(reg, ["c"])[0]).toBe(reg[2]);
  });
});

describe("moveInOrder", () => {
  it("materializes the full order from an empty one", () => {
    expect(moveInOrder(REG, [], "c", -1)).toEqual(["a", "c", "b"]);
  });

  it("moves down", () => {
    expect(moveInOrder(REG, [], "a", 1)).toEqual(["b", "a", "c"]);
  });

  it("leaves the stored order untouched at either end", () => {
    const order = ["a", "b", "c"];
    expect(moveInOrder(REG, order, "a", -1)).toBe(order);
    expect(moveInOrder(REG, order, "c", 1)).toBe(order);
  });

  it("leaves the stored order untouched for an unknown id", () => {
    const order = ["a", "b", "c"];
    expect(moveInOrder(REG, order, "gone", -1)).toBe(order);
  });

  it("moves by one place even when the stored order was partial", () => {
    // Stored ["c"] arranges to c,a,b — moving "a" up must swap with "c", not jump to the front.
    expect(moveInOrder(REG, ["c"], "a", -1)).toEqual(["a", "c", "b"]);
  });
});

describe("toggleHidden", () => {
  it("adds on hide and removes on show", () => {
    expect(toggleHidden([], "a", false)).toEqual(["a"]);
    expect(toggleHidden(["a", "b"], "a", true)).toEqual(["b"]);
  });

  it("never duplicates an id that is already hidden", () => {
    expect(toggleHidden(["a"], "a", false)).toEqual(["a"]);
  });
});
