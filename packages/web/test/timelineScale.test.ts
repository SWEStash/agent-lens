import { describe, it, expect } from "vitest";
import { BREAK_PX, IDLE_GAP_MS, buildScale, type ScaleInput } from "../src/transcript/timeline/scale";

const T0 = Date.parse("2026-08-01T10:00:00Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

/** Events at the given millisecond offsets from a fixed origin. */
const at = (...offsets: number[]): ScaleInput[] => offsets.map((o, i) => ({ uuid: `e${i}`, timestamp: iso(o) }));

const WIDTH = 1000;

describe("buildScale — placement", () => {
  it("spreads a gapless session across the full width, in timestamp order", () => {
    const s = buildScale(at(0, 1000, 2000, 3000), { width: WIDTH });
    expect(s.segments).toHaveLength(1);
    expect(s.breaks).toHaveLength(0);
    expect(s.points.map((p) => p.uuid)).toEqual(["e0", "e1", "e2", "e3"]);
    expect(s.x(T0)).toBe(0);
    expect(s.x(T0 + 3000)).toBeCloseTo(WIDTH, 6);
    expect(s.x(T0 + 1500)).toBeCloseTo(WIDTH / 2, 6);
  });

  it("sorts by timestamp rather than trusting arrival order", () => {
    // 2 024 events across 408 sessions carry a timestamp earlier than their predecessor's; drawing in
    // arrival order would run the axis backwards.
    const out = [
      { uuid: "late", timestamp: iso(3000) },
      { uuid: "early", timestamp: iso(0) },
      { uuid: "mid", timestamp: iso(1500) },
    ];
    const s = buildScale(out, { width: WIDTH });
    expect(s.points.map((p) => p.uuid)).toEqual(["early", "mid", "late"]);
    const xs = s.points.map((p) => s.x(p.t));
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  it("is monotonic and round-trips t -> x -> t inside a segment", () => {
    const s = buildScale(at(0, 5000, 20_000, 45_000), { width: WIDTH });
    for (const p of s.points) expect(s.t(s.x(p.t))).toBeCloseTo(p.t, 3);
    const xs = s.points.map((p) => s.x(p.t));
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  it("clamps outside the domain instead of extrapolating", () => {
    const s = buildScale(at(0, 1000), { width: WIDTH });
    expect(s.x(T0 - 999_999)).toBe(0);
    expect(s.x(T0 + 999_999)).toBeCloseTo(WIDTH, 6);
    expect(s.t(-50)).toBe(T0);
    expect(s.t(WIDTH + 50)).toBe(T0 + 1000);
  });
});

describe("buildScale — gap compression", () => {
  it("collapses a gap over the threshold to a fixed-width break", () => {
    const fourHours = 4 * 60 * 60 * 1000;
    const s = buildScale(at(0, 1000, 1000 + fourHours, 1000 + fourHours + 1000), { width: WIDTH });
    expect(s.breaks).toHaveLength(1);
    expect(s.segments).toHaveLength(2);
    expect(s.breaks[0].x1 - s.breaks[0].x0).toBeCloseTo(BREAK_PX, 6);
    expect(s.breaks[0].durationMs).toBe(fourHours);
    // The dominant gap must NOT dominate the width: the two 1s segments split what's left evenly.
    expect(s.segments[0].x1 - s.segments[0].x0).toBeCloseTo((WIDTH - BREAK_PX) / 2, 6);
    expect(s.idleMs).toBe(fourHours);
    expect(s.activeMs).toBe(2000);
  });

  it("leaves a gap exactly at the threshold alone, and breaks one just over it", () => {
    expect(buildScale(at(0, IDLE_GAP_MS), { width: WIDTH }).breaks).toHaveLength(0);
    expect(buildScale(at(0, IDLE_GAP_MS + 1), { width: WIDTH }).breaks).toHaveLength(1);
  });

  it("literal mode (gapMs: Infinity) is byte-identical when no gap exceeds the threshold", () => {
    const evs = at(0, 1000, 2000, 30_000);
    const compressed = buildScale(evs, { width: WIDTH });
    const literal = buildScale(evs, { width: WIDTH, gapMs: Infinity });
    expect(compressed.segments).toEqual(literal.segments);
    expect(compressed.breaks).toEqual(literal.breaks);
    expect(compressed.points).toEqual(literal.points);
  });

  it("literal mode keeps the real proportions a compressed axis hides", () => {
    const day = 24 * 60 * 60 * 1000;
    const evs = at(0, 1000, day, day + 1000);
    const literal = buildScale(evs, { width: WIDTH, gapMs: Infinity });
    expect(literal.breaks).toHaveLength(0);
    // The 1s of work at the start occupies well under a pixel of a day-wide axis — the exact problem
    // compression exists to solve.
    expect(literal.x(T0 + 1000)).toBeLessThan(1);
  });

  it("never draws a mark across a break", () => {
    const s = buildScale(at(0, 1000, 1000 + 10 * 60_000), { width: WIDTH });
    expect(s.points[0].durationMs).toBe(1000); // inside the segment
    expect(s.points[1].durationMs).toBe(0); // followed by a break
    expect(s.points[2].durationMs).toBe(0); // last event
  });

  it("resolves a pixel inside a break to the nearer real boundary", () => {
    const hour = 60 * 60 * 1000;
    const s = buildScale(at(0, 1000, 1000 + hour, 1000 + hour + 1000), { width: WIDTH });
    const b = s.breaks[0];
    expect(s.t(b.x0 + 1)).toBe(b.t0);
    expect(s.t(b.x1 - 1)).toBe(b.t1);
  });

  it("keeps every segment on screen when breaks outnumber the available width", () => {
    // 200 breaks at 14px each want 2 800px of a 300px band; widths must stay finite and in order.
    const evs = at(...Array.from({ length: 201 }, (_, i) => i * (IDLE_GAP_MS + 1000)));
    const s = buildScale(evs, { width: 300 });
    expect(s.breaks).toHaveLength(200);
    for (const seg of s.segments) {
      expect(Number.isFinite(seg.x0)).toBe(true);
      expect(seg.x1).toBeGreaterThanOrEqual(seg.x0);
      expect(seg.x1).toBeLessThanOrEqual(300 + 1e-6);
    }
  });
});

describe("buildScale — degenerate and empty sessions", () => {
  it("places a single event without dividing by zero", () => {
    const s = buildScale(at(0), { width: WIDTH });
    expect(s.degenerate).toBe(true);
    expect(s.spanMs).toBe(0);
    expect(s.points).toHaveLength(1);
    expect(Number.isFinite(s.x(T0))).toBe(true);
    expect(s.t(s.x(T0))).toBeCloseTo(T0, -2);
  });

  it("handles a session whose timestamps are all equal", () => {
    const s = buildScale(at(0, 0, 0, 0), { width: WIDTH });
    expect(s.degenerate).toBe(true);
    expect(s.breaks).toHaveLength(0);
    expect(s.points).toHaveLength(4);
    for (const p of s.points) expect(Number.isFinite(s.x(p.t))).toBe(true);
  });

  it("drops events with no timestamp but keeps the rest placed", () => {
    const evs: ScaleInput[] = [
      { uuid: "a", timestamp: iso(0) },
      { uuid: "no-ts", timestamp: null },
      { uuid: "bad-ts", timestamp: "not a date" },
      { uuid: "b", timestamp: iso(1000) },
    ];
    const s = buildScale(evs, { width: WIDTH });
    expect(s.points.map((p) => p.uuid)).toEqual(["a", "b"]);
  });

  it("returns an empty scale when nothing has a timestamp", () => {
    const s = buildScale([{ uuid: "a", timestamp: null }], { width: WIDTH });
    expect(s.domain).toBeNull();
    expect(s.points).toEqual([]);
    expect(s.segments).toEqual([]);
    expect(s.degenerate).toBe(true);
    expect(s.x(T0)).toBe(0);
    expect(s.t(500)).toBe(0);
  });

  it("survives a zero width", () => {
    const s = buildScale(at(0, 1000, 100_000), { width: 0 });
    expect(s.width).toBe(0);
    for (const seg of s.segments) expect(Number.isFinite(seg.x0)).toBe(true);
  });
});

describe("buildScale — an expanded gap", () => {
  const hour = 60 * 60 * 1000;
  const evs = at(0, 1000, 1000 + hour, 1000 + hour + 1000);

  it("keeps a chosen gap at its real duration instead of collapsing it", () => {
    const collapsed = buildScale(evs, { width: WIDTH });
    expect(collapsed.breaks).toHaveLength(1);
    expect(collapsed.expanded).toHaveLength(0);

    const opened = buildScale(evs, { width: WIDTH, expandedGaps: new Set([T0 + 1000]) });
    expect(opened.breaks).toHaveLength(0);
    expect(opened.segments).toHaveLength(1);
    // It stays reported, so the band can still draw it and let the reader collapse it again —
    // otherwise expanding would be a one-way door.
    expect(opened.expanded).toHaveLength(1);
    expect(opened.expanded[0].durationMs).toBe(hour);
    expect(opened.expanded[0].x1 - opened.expanded[0].x0).toBeGreaterThan(WIDTH * 0.9);
  });

  it("ignores an expansion key that matches no gap", () => {
    const s = buildScale(evs, { width: WIDTH, expandedGaps: new Set([T0 + 999_999]) });
    expect(s.breaks).toHaveLength(1);
    expect(s.expanded).toHaveLength(0);
  });
});

describe("buildScale — zoom", () => {
  it("re-derives segments over a narrowed domain", () => {
    const hour = 60 * 60 * 1000;
    const evs = at(0, 1000, hour, hour + 1000, 2 * hour);
    const full = buildScale(evs, { width: WIDTH });
    expect(full.breaks).toHaveLength(2);

    const zoomed = buildScale(evs, { width: WIDTH, domain: [T0 + hour, T0 + hour + 1000] });
    expect(zoomed.points.map((p) => p.uuid)).toEqual(["e2", "e3"]);
    expect(zoomed.breaks).toHaveLength(0);
    expect(zoomed.x(T0 + hour)).toBe(0);
    expect(zoomed.x(T0 + hour + 1000)).toBeCloseTo(WIDTH, 6);
  });

  it("a domain containing nothing yields an empty scale rather than throwing", () => {
    const s = buildScale(at(0, 1000), { width: WIDTH, domain: [T0 + 500_000, T0 + 600_000] });
    expect(s.domain).toBeNull();
    expect(s.points).toEqual([]);
  });
});
