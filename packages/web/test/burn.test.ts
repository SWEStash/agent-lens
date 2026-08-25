/**
 * The burn fold turns UTC hours into local weekday/hour/week buckets. Every case pins an explicit
 * zone: reading the host zone (UTC-3) would let an off-by-one offset pass unnoticed.
 */
import { describe, it, expect } from "vitest";
import { heatCells, heatRows, rampColor, rampPosition, rampTicks, burnBySource, isoWeek, type BurnHour, type HeatRow } from "../src/dashboard/burn";

const row = (hour: string, work: number, source: string | null = "isf"): BurnHour => ({ hour, source, work });
/** heatCells folds whichever metric is selected, so its rows carry a bare `value`, not `work`. */
const cellRow = (hour: string, value: number): HeatRow => ({ hour, value });

describe("heatCells", () => {
  it("places an hour in the local weekday, not the UTC one", () => {
    // Sunday 2026-03-01T01:00Z is Saturday 22:00 in Buenos Aires.
    const { cells } = heatCells([cellRow("2026-03-01T01", 100)], "America/Argentina/Buenos_Aires");
    const hit = cells.filter((c) => c.total > 0);
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ weekday: 6, hour: 22, total: 100 });
  });

  it("divides by how many times that weekday occurs, not by the range length", () => {
    // Two Mondays with 100 each, one Tuesday with 100. Monday's mean is 100, not 200.
    const { cells } = heatCells(
      [cellRow("2026-03-02T12", 100), cellRow("2026-03-09T12", 100), cellRow("2026-03-03T12", 100)],
      "UTC",
    );
    const at = (wd: number, h: number) => cells.find((c) => c.weekday === wd && c.hour === h)!;
    expect(at(1, 12)).toMatchObject({ total: 200, mean: 100 });
    expect(at(2, 12)).toMatchObject({ total: 100, mean: 100 });
  });

  it("counts a weekday nobody worked as a real zero, not as an absent day", () => {
    // Two Sundays in the span, spend on only one of them. Halving it is the whole point: reading it
    // as one 100-token Sunday overstates a weekday that is simply often skipped.
    const rows = [cellRow("2026-03-01T12", 100), cellRow("2026-03-04T12", 60)]; // Sun 1st, Wed 4th
    const { cells } = heatCells(rows, "UTC", { from: "2026-03-01", to: "2026-03-11" });
    const at = (wd: number, h: number) => cells.find((c) => c.weekday === wd && c.hour === h)!;
    expect(at(0, 12)).toMatchObject({ total: 100, mean: 50 }); // 2 Sundays: the 1st and the 8th
    expect(at(3, 12)).toMatchObject({ total: 60, mean: 30 }); // 2 Wednesdays: the 4th and the 11th
  });

  it("normalizes over the requested range, including the empty days at its edges", () => {
    // One worked Sunday, but the reader asked for four weeks — the other three Sundays are zeros
    // that only the range knows about, since no row can carry a day with no usage on it.
    const rows = [cellRow("2026-03-01T12", 100)];
    const at = (cs: ReturnType<typeof heatCells>["cells"]) => cs.find((c) => c.weekday === 0 && c.hour === 12)!;
    expect(at(heatCells(rows, "UTC", { from: "2026-03-01", to: "2026-03-28" }).cells).mean).toBe(25);
    // Only the payload to go on: the span is that single day, so the mean is the day itself.
    expect(at(heatCells(rows, "UTC").cells).mean).toBe(100);
  });

  it("falls back to the payload span when the range is half-set or reversed", () => {
    const rows = [cellRow("2026-03-01T12", 100), cellRow("2026-03-08T12", 100)]; // two Sundays
    const at = (cs: ReturnType<typeof heatCells>["cells"]) => cs.find((c) => c.weekday === 0 && c.hour === 12)!;
    expect(at(heatCells(rows, "UTC", { from: "2026-03-01" }).cells).mean).toBe(100);
    expect(at(heatCells(rows, "UTC", { to: "2026-03-28" }).cells).mean).toBe(100);
    // A `to` before `from` would otherwise divide every cell by zero and blank the whole tile.
    expect(at(heatCells(rows, "UTC", { from: "2026-03-28", to: "2026-03-01" }).cells).mean).toBe(100);
  });

  it("shares one denominator across a weekday's 24 hours", () => {
    // One Monday, spend split over two hours: the row's means sum to that day's real total.
    const { cells } = heatCells([cellRow("2026-03-02T09", 60), cellRow("2026-03-02T17", 40)], "UTC");
    const monday = cells.filter((c) => c.weekday === 1);
    expect(monday.reduce((a, c) => a + c.mean, 0)).toBe(100);
  });

  it("always returns the full 7x24 grid, including empty cells", () => {
    const { cells, max } = heatCells([], "UTC");
    expect(cells).toHaveLength(168);
    expect(max).toBe(0);
  });
});

describe("heatRows", () => {
  const time = {
    burn_hours: [{ hour: "2026-03-02T12", source: "isf", work: 900 }],
    turn_hours: [{ hour: "2026-03-02T12", source: "isf", turns: 3 }],
  } as never;

  it("plots turns and tokens from their own series, not one converted into the other", () => {
    expect(heatRows(time, "tokens")).toEqual([{ hour: "2026-03-02T12", value: 900 }]);
    expect(heatRows(time, "turns")).toEqual([{ hour: "2026-03-02T12", value: 3 }]);
  });

  it("has nothing to plot before the payload lands", () => {
    expect(heatRows(null, "turns")).toEqual([]);
  });
});

describe("the metric a heatmap cell is read through", () => {
  // The reason the default is turns. Numbers are this corpus's: one Sunday carried a 12-minute
  // fan-out of 258 subagents, and a different Sunday hour was worked five weeks out of fourteen.
  // Pinned to UTC so the dates read as the Sundays they are; the local fold has its own cases above.
  const SPAN = { from: "2026-05-22", to: "2026-08-23" }; // 14 Sundays
  const oneOff = "2026-08-16T07"; // one Sunday, 07:00
  const habit = ["2026-06-07T21", "2026-06-14T21", "2026-07-05T21", "2026-07-19T21", "2026-08-09T21"]; // five Sundays, 21:00

  const meanAt = (rows: HeatRow[], weekday: number, hour: number) =>
    heatCells(rows, "UTC", SPAN).cells.find((c) => c.weekday === weekday && c.hour === hour)!.mean;

  it("lets one burst of tokens look like a habit", () => {
    const rows = [cellRow(oneOff, 881_313), ...habit.map((h) => cellRow(h, 64_732 * 14 / 5))];
    // Within a few percent of each other, so they render as the same colour.
    expect(Math.abs(meanAt(rows, 0, 7) / meanAt(rows, 0, 21) - 1)).toBeLessThan(0.05);
  });

  it("keeps them apart when the metric is turns", () => {
    const rows = [cellRow(oneOff, 1), ...habit.map((h) => cellRow(h, 2))];
    expect(meanAt(rows, 0, 21) / meanAt(rows, 0, 7)).toBeGreaterThan(5);
  });
});

describe("rampPosition", () => {
  it("gives an empty cell no position at all — it is not the bottom of the scale", () => {
    expect(rampPosition(0, 100, "linear")).toBeNull();
    expect(rampPosition(-1, 100, "linear")).toBeNull();
    expect(rampPosition(5, 0, "linear")).toBeNull();
  });

  it("places a small value where its size says, once the scale stops compressing", () => {
    // The cell that started this: 0.07 turns against a 5.0 peak. Under sqrt it sat a tenth of the way
    // up the ramp; it is 1.4% of the peak and should look like it.
    expect(rampPosition(0.07, 5, "linear")).toBeCloseTo(0.014, 3);
    expect(rampPosition(0.07, 5, "sqrt")).toBeCloseTo(0.118, 3);
  });

  it("still compresses tokens, where the spread genuinely is extreme", () => {
    expect(rampPosition(6_000, 840_594, "sqrt")).toBeGreaterThan(rampPosition(6_000, 840_594, "linear")!);
  });

  it("never runs past the top of the ramp", () => {
    expect(rampPosition(200, 100, "linear")).toBe(1);
    expect(rampPosition(200, 100, "sqrt")).toBe(1);
  });
});

describe("rampColor", () => {
  const stops = ["#000000", "#808080", "#ffffff"];

  it("lands exactly on a stop at its own position", () => {
    expect(rampColor(0, stops)).toBe("#000000");
    expect(rampColor(0.5, stops)).toBe("#808080");
    expect(rampColor(1, stops)).toBe("#ffffff");
  });

  it("interpolates between them rather than snapping to one", () => {
    expect(rampColor(0.25, stops)).toBe("#404040");
    expect(rampColor(0.75, stops)).toBe("#c0c0c0");
  });

  it("is continuous at the bottom — a barely-there value is barely coloured", () => {
    // The whole point of the gradient: 1.4% up the ramp renders 1.4% up, not at a fixed first step.
    // 0x04 of 0xff is 1.4% — the cell is a hair off the empty colour, which is what it is worth.
    expect(rampColor(0.014, stops)).toBe("#040404");
  });

  it("clamps rather than throwing when a caller hands it something out of range", () => {
    expect(rampColor(-5, stops)).toBe("#000000");
    expect(rampColor(5, stops)).toBe("#ffffff");
    expect(rampColor(0.5, ["#123456"])).toBe("#123456");
  });
});

describe("rampTicks", () => {
  it("spaces ticks evenly along the bar and bends the values instead", () => {
    expect(rampTicks(100, "linear", 5)).toEqual([[0, 0], [0.25, 25], [0.5, 50], [0.75, 75], [1, 100]]);
    // Under sqrt the same even positions mean squared values — which is what makes the strip readable.
    expect(rampTicks(100, "sqrt", 5)).toEqual([[0, 0], [0.25, 6.25], [0.5, 25], [0.75, 56.25], [1, 100]]);
  });

  it("has nothing to label without a maximum", () => {
    expect(rampTicks(0, "linear")).toEqual([]);
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
