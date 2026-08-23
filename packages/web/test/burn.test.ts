/**
 * The burn fold turns UTC hours into local weekday/hour/week buckets. Every case pins an explicit
 * zone: reading the host zone (UTC-3) would let an off-by-one offset pass unnoticed.
 */
import { describe, it, expect } from "vitest";
import { heatCells, rampStep, burnBySource, isoWeek, type BurnHour } from "../src/dashboard/burn";

const row = (hour: string, work: number, source: string | null = "isf"): BurnHour => ({ hour, source, work });

describe("heatCells", () => {
  it("places an hour in the local weekday, not the UTC one", () => {
    // Sunday 2026-03-01T01:00Z is Saturday 22:00 in Buenos Aires.
    const { cells } = heatCells([row("2026-03-01T01", 100)], "America/Argentina/Buenos_Aires");
    const hit = cells.filter((c) => c.total > 0);
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ weekday: 6, hour: 22, total: 100 });
  });

  it("divides by how many times that weekday was observed, not by the range length", () => {
    // Two Mondays with 100 each, one Tuesday with 100. Monday's mean is 100, not 200.
    const { cells } = heatCells(
      [row("2026-03-02T12", 100), row("2026-03-09T12", 100), row("2026-03-03T12", 100)],
      "UTC",
    );
    const at = (wd: number, h: number) => cells.find((c) => c.weekday === wd && c.hour === h)!;
    expect(at(1, 12)).toMatchObject({ total: 200, mean: 100 });
    expect(at(2, 12)).toMatchObject({ total: 100, mean: 100 });
  });

  it("shares one denominator across a weekday's 24 hours", () => {
    // One Monday, spend split over two hours: the row's means sum to that day's real total.
    const { cells } = heatCells([row("2026-03-02T09", 60), row("2026-03-02T17", 40)], "UTC");
    const monday = cells.filter((c) => c.weekday === 1);
    expect(monday.reduce((a, c) => a + c.mean, 0)).toBe(100);
  });

  it("always returns the full 7x24 grid, including empty cells", () => {
    const { cells, max } = heatCells([], "UTC");
    expect(cells).toHaveLength(168);
    expect(max).toBe(0);
  });
});

describe("rampStep", () => {
  it("reserves step 0 for no spend at all", () => {
    expect(rampStep(0, 100, 5)).toBe(0);
  });

  it("gives any non-zero spend at least the first step", () => {
    expect(rampStep(0.0001, 1_000_000, 5)).toBe(1);
  });

  it("puts the maximum in the last step and never past it", () => {
    expect(rampStep(100, 100, 5)).toBe(5);
    expect(rampStep(200, 100, 5)).toBe(5);
  });

  it("is compressive, so a skewed distribution is not all first-step", () => {
    // A cell at 1/4 of the peak sits mid-ramp under sqrt; linear would floor it at step 2.
    expect(rampStep(25, 100, 5)).toBe(3);
  });

  it("degrades to 0 when there is no maximum", () => {
    expect(rampStep(5, 0, 5)).toBe(0);
  });
});

describe("burnBySource", () => {
  it("keeps sources separate rather than summing them", () => {
    const { points, sources } = burnBySource(
      [row("2026-03-02T12", 10, "isf"), row("2026-03-03T12", 5, "personal")],
      "UTC",
      "week",
    );
    expect(sources).toEqual(["isf", "personal"]);
    expect(points).toHaveLength(1);
    expect(points[0].bySource).toEqual({ isf: 10, personal: 5 });
  });

  it("buckets by the LOCAL week, so a UTC Monday can belong to the previous one", () => {
    // 2026-03-02T01:00Z is Monday W10 in UTC but Sunday W09 in Buenos Aires.
    const rows = [row("2026-03-02T01", 1)];
    expect(burnBySource(rows, "UTC", "week").points[0].bucket).toBe("2026-W10");
    expect(burnBySource(rows, "America/Argentina/Buenos_Aires", "week").points[0].bucket).toBe("2026-W09");
  });

  it("splits by day when the dashboard asks for days, instead of flattening into one week", () => {
    const rows = [row("2026-03-02T12", 10), row("2026-03-03T12", 5)];
    expect(burnBySource(rows, "UTC", "week").points).toHaveLength(1);
    const { points } = burnBySource(rows, "UTC", "day");
    expect(points.map((p) => p.bucket)).toEqual(["2026-03-02", "2026-03-03"]);
    expect(points.map((p) => p.bySource.isf)).toEqual([10, 5]);
  });

  it("folds a whole month into one bucket when asked", () => {
    const { points } = burnBySource([row("2026-03-02T12", 10), row("2026-03-30T12", 5)], "UTC", "month");
    expect(points).toEqual([{ bucket: "2026-03", bySource: { isf: 15 } }]);
  });

  it("sorts buckets chronologically at every granularity", () => {
    const rows = [row("2026-04-01T12", 1), row("2026-03-02T12", 1), row("2026-03-20T12", 1)];
    for (const bucket of ["day", "week", "month"] as const) {
      const keys = burnBySource(rows, "UTC", bucket).points.map((p) => p.bucket);
      expect([...keys].sort()).toEqual(keys);
    }
  });

  it("labels a null source rather than dropping it", () => {
    expect(burnBySource([row("2026-03-02T12", 7, null)], "UTC", "week").sources).toEqual(["(unassigned)"]);
  });

  it("returns nothing for no rows rather than throwing", () => {
    expect(burnBySource([], "UTC", "day")).toEqual({ points: [], sources: [] });
  });
});

describe("isoWeek", () => {
  it("starts weeks on Monday", () => {
    expect(isoWeek("2026-03-01")).toBe("2026-W09"); // Sunday closes W09
    expect(isoWeek("2026-03-02")).toBe("2026-W10"); // Monday opens W10
  });

  it("keeps a year-straddling week whole rather than splitting it", () => {
    expect(isoWeek("2025-12-31")).toBe(isoWeek("2026-01-01"));
  });
});
