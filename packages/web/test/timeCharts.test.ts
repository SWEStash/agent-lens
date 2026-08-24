/**
 * TIME_CHART_IDS drives the visibility gate in Dashboard.tsx: while every id in it is hidden, the
 * `/api/dashboard/time` request is skipped entirely. That makes it a second list that has to track
 * the registry — and the failure is silent in both directions. A stale id leaves a tile permanently
 * starved of its payload; a missing one makes every dashboard load pay for a tile nobody is showing.
 */
import { describe, it, expect } from "vitest";
import { CHART_REGISTRY, TIME_CHART_IDS } from "../src/dashboard/registry";
import { decadeDomain } from "../src/dashboard/charts/common";

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

/**
 * The latency tile plots on a log axis because its series span four orders of magnitude — a median
 * under a second beside a p90 of ninety minutes. Getting the domain wrong is the kind of bug that
 * still renders a plausible-looking chart, so the arithmetic is pinned here.
 */
describe("decadeDomain", () => {
  it("snaps out to whole decades around the data", () => {
    const { domain, ticks } = decadeDomain([633, 5_241_337]);
    expect(domain).toEqual([100, 10_000_000]);
    expect(ticks).toEqual([100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000]);
  });

  it("keeps an axis a decade tall when every value shares one decade", () => {
    // lo === hi would otherwise give a zero-height axis and nothing would render.
    const { domain, ticks } = decadeDomain([1_200, 3_400]);
    expect(domain).toEqual([1_000, 10_000]);
    expect(ticks).toEqual([1_000, 10_000]);
  });

  it("drops non-positive values rather than clamping them onto the first decade", () => {
    // A log axis has no room for 0; moving it up would misplace it by however many decades that took.
    expect(decadeDomain([0, -5, 2_000]).domain).toEqual([1_000, 10_000]);
  });

  it("falls back rather than collapsing when nothing is visible", () => {
    expect(decadeDomain([]).domain).toEqual([1_000, 100_000]);
    expect(decadeDomain([], [1, 10]).domain).toEqual([1, 10]);
  });
});
