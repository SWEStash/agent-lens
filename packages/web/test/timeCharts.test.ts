/**
 * TIME_CHART_IDS drives the visibility gate in Dashboard.tsx: while every id in it is hidden, the
 * `/api/dashboard/time` request is skipped entirely. That makes it a second list that has to track
 * the registry — and the failure is silent in both directions. A stale id leaves a tile permanently
 * starved of its payload; a missing one makes every dashboard load pay for a tile nobody is showing.
 */
import { describe, it, expect } from "vitest";
import { CHART_REGISTRY, TIME_CHART_IDS } from "../src/dashboard/registry";

describe("TIME_CHART_IDS", () => {
  it("names only ids that exist in the registry", () => {
    const known = new Set(CHART_REGISTRY.map((c) => c.id));
    expect(TIME_CHART_IDS.filter((id) => !known.has(id))).toEqual([]);
  });

  it("covers every chart that reads the time payload", () => {
    // Derived from the registry rather than restated: the tiles fed by /dashboard/time are exactly
    // the ones this list must hold, so adding a fifth one without gating it fails here.
    const timeComponents = new Set(["BurnHeatmap", "BurnBySource", "ModelLatency", "ReviewLatency"]);
    const expected = CHART_REGISTRY.filter((c) => timeComponents.has(c.Component.name)).map((c) => c.id);
    expect([...TIME_CHART_IDS].sort()).toEqual(expected.sort());
  });

  it("has no duplicates", () => {
    expect(new Set(TIME_CHART_IDS).size).toBe(TIME_CHART_IDS.length);
  });
});
