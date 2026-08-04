/**
 * Dashboard layout rules. These are the parts that outlive any one release: a stored layout has to keep
 * working when the chart/KPI registries gain and lose entries, a preset that disappears must not strand
 * anyone, and an upgrading user's pre-layout `dashboard.charts` choice has to survive.
 */
import { describe, expect, it } from "vitest";
import {
  arrange,
  arrangeIds,
  emptyBody,
  emptyLayout,
  moveInOrder,
  normalizeLayout,
  presetBody,
  resolveActive,
  resolveBody,
  toggleHidden,
  withBody,
  type DashLayout,
} from "../src/dashboard/layout";
import { findPreset } from "../src/dashboard/presets";

const REG = ["a", "b", "c"];
// Stand-in registries for the resolution tests, so they don't move whenever a real tile is added.
const KPIS = ["cost", "cost-per-session", "sessions", "turns"];
const CHARTS = ["cost-over-time", "tokens-over-time", "tokens-by-model", "activity"];

describe("normalizeLayout", () => {
  it("returns defaults for null, garbage and non-objects", () => {
    for (const raw of [null, undefined, 42, "nope"]) {
      expect(normalizeLayout(raw)).toEqual(emptyLayout());
    }
  });

  it("defaults a fresh install to the all view with no custom layout", () => {
    expect(normalizeLayout(null)).toEqual({ v: 1, active: "all", custom: null, kpisCollapsed: false });
  });

  it("keeps a stored active view and custom body", () => {
    const stored = { v: 1, active: "cost", custom: { kpis: { hidden: ["turns"], order: [] }, charts: {} }, kpisCollapsed: true };
    expect(normalizeLayout(stored)).toEqual({
      v: 1,
      active: "cost",
      custom: { kpis: { hidden: ["turns"], order: [] }, charts: { hidden: [], order: [] } },
      kpisCollapsed: true,
    });
  });

  it("falls back to the all view when active is missing or not a string", () => {
    expect(normalizeLayout({ custom: null }).active).toBe("all");
    expect(normalizeLayout({ active: 7 }).active).toBe("all");
  });

  it("drops non-string entries instead of trusting the stored JSON", () => {
    const l = normalizeLayout({ active: "custom", custom: { kpis: { hidden: ["a", 3, null], order: "b" } } });
    expect(l.custom!.kpis).toEqual({ hidden: ["a"], order: [] });
  });

  it("reads kpisCollapsed only when it is exactly true", () => {
    expect(normalizeLayout({ kpisCollapsed: true }).kpisCollapsed).toBe(true);
    expect(normalizeLayout({ kpisCollapsed: "yes" }).kpisCollapsed).toBe(false);
  });

  it("seeds a custom view from the legacy dashboard.charts array", () => {
    // Hiding those charts WAS a customization, so the upgrading user lands on their own view, not `all`.
    const l = normalizeLayout(null, ["cost-over-time"]);
    expect(l.active).toBe("custom");
    expect(l.custom!.charts).toEqual({ hidden: ["cost-over-time"], order: [] });
  });

  it("stays on the all view when the legacy value is empty", () => {
    expect(normalizeLayout(null, [])).toEqual(emptyLayout());
  });

  it("ignores the legacy value once a layout exists", () => {
    expect(normalizeLayout({ active: "all" }, ["cost-over-time"])).toEqual({ v: 1, active: "all", custom: null, kpisCollapsed: false });
  });

  it("does not share array instances between calls", () => {
    const a = normalizeLayout(null, ["x"]);
    a.custom!.kpis.hidden.push("y");
    expect(normalizeLayout(null, ["x"]).custom!.kpis.hidden).toEqual([]);
  });
});

describe("presetBody", () => {
  it("shows everything for a preset that declares no strips (the all view)", () => {
    expect(presetBody({ id: "all", label: "All" }, KPIS, CHARTS)).toEqual(emptyBody());
  });

  it("turns the declared ids into the order and hides the rest", () => {
    const body = presetBody(findPreset("cost")!, KPIS, CHARTS);
    expect(body.kpis.order[0]).toBe("cost");
    expect(body.kpis.hidden).toEqual(["turns"]); // the only KPI the cost view doesn't declare
    expect(body.charts.hidden).toEqual(["activity"]);
  });

  it("hides a registry entry the preset was written before — curated views don't silently grow", () => {
    const body = presetBody(findPreset("cost")!, [...KPIS, "brand-new-tile"], CHARTS);
    expect(body.kpis.hidden).toContain("brand-new-tile");
  });
});

describe("resolveBody", () => {
  const custom = { kpis: { hidden: ["sessions"], order: [] }, charts: { hidden: [], order: [] } };
  const layout = (active: string, c = custom): DashLayout => ({ v: 1, active, custom: c, kpisCollapsed: false });

  it("resolves the custom view to the stored body", () => {
    expect(resolveBody(layout("custom"), KPIS, CHARTS)).toBe(custom);
  });

  it("resolves a preset without touching the stored custom body", () => {
    const l = layout("cost");
    expect(resolveBody(l, KPIS, CHARTS).kpis.hidden).toEqual(["turns"]);
    expect(l.custom).toBe(custom);
  });

  it("shows everything on the all view even when a custom layout exists", () => {
    expect(resolveBody(layout("all"), KPIS, CHARTS)).toEqual(emptyBody());
  });

  it("falls back to the custom body when active names a preset that no longer exists", () => {
    expect(resolveBody(layout("removed-in-v2"), KPIS, CHARTS)).toBe(custom);
  });

  it("falls back to everything-visible when there is no custom body either", () => {
    expect(resolveBody(layout("removed-in-v2", null as never), KPIS, CHARTS)).toEqual(emptyBody());
  });
});

describe("resolveActive", () => {
  const body = { kpis: { hidden: [], order: [] }, charts: { hidden: [], order: [] } };

  it("passes through a live preset id and the custom view", () => {
    expect(resolveActive({ v: 1, active: "cost", custom: null, kpisCollapsed: false })).toBe("cost");
    expect(resolveActive({ v: 1, active: "custom", custom: body, kpisCollapsed: false })).toBe("custom");
  });

  it("falls back the same way resolveBody does, so the switcher can't disagree with the page", () => {
    expect(resolveActive({ v: 1, active: "gone", custom: body, kpisCollapsed: false })).toBe("custom");
    expect(resolveActive({ v: 1, active: "gone", custom: null, kpisCollapsed: false })).toBe("all");
  });
});

describe("withBody (fork on edit)", () => {
  it("commits an edited body as the custom view and switches to it", () => {
    const l: DashLayout = { v: 1, active: "cost", custom: null, kpisCollapsed: false };
    // The caller mutates the RESOLVED body — so a fork from "cost" starts from cost's selection.
    const edited = resolveBody(l, KPIS, CHARTS);
    edited.kpis.hidden = toggleHidden(edited.kpis.hidden, "cost", false);

    const next = withBody(l, edited);
    expect(next.active).toBe("custom");
    expect(next.custom!.kpis.hidden).toEqual(["turns", "cost"]); // cost's hidden set, plus the new one
  });

  it("carries the collapse state across a fork — it is not part of the selection", () => {
    const l: DashLayout = { v: 1, active: "cost", custom: null, kpisCollapsed: true };
    expect(withBody(l, emptyBody()).kpisCollapsed).toBe(true);
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
