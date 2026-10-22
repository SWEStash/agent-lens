/**
 * Context occupancy on the timeline band. The number itself is the thing to pin: it is the whole
 * prompt the model was sent (input + cache-write + cache-read) and NOT the work-token metric the bars
 * use, so the two must not quietly become the same field.
 */
import { describe, it, expect } from "vitest";
import { barHeight, buildMarks, contextLine, contextTokens, heightReference, metricValue, type Mark } from "../src/transcript/timeline/marks";
import type { EventNode } from "../src/api";

const ev = (uuid: string, usage: EventNode["usage"] | null): EventNode =>
  ({ uuid, session_id: "s", role: "assistant", type: "assistant", timestamp: "2026-04-01T10:00:00Z", toolCalls: [], usage }) as unknown as EventNode;

const usage = (input: number, output: number, cw: number, cr: number) => ({
  input,
  output,
  cache_creation: cw,
  cache_read: cr,
});

describe("contextTokens", () => {
  it("is the prompt that went in, not the answer that came back", () => {
    // Output is excluded on purpose: it is what the model produced, not what it had to carry.
    expect(contextTokens(ev("a", usage(1_000, 9_999, 2_000, 120_000)))).toBe(123_000);
  });

  it("is not the work-token metric — cache reads dominate it and are excluded there", () => {
    const e = ev("a", usage(1_000, 500, 2_000, 120_000));
    expect(metricValue(e, "work")).toBe(3_500);
    expect(contextTokens(e)).toBe(123_000);
  });

  it("is zero for an event with no usage row, so the line simply has no point there", () => {
    expect(contextTokens(ev("a", null))).toBe(0);
  });
});

describe("buildMarks", () => {
  it("carries context alongside the metric value on every mark", () => {
    const events = [ev("a", usage(10, 20, 30, 40)), ev("b", null)];
    const points = [
      { uuid: "a", t: 0, durationMs: 0 },
      { uuid: "b", t: 1, durationMs: 0 },
    ];
    const marks = buildMarks({ events, points, metric: "work" });
    expect(marks.map((m) => ({ uuid: m.uuid, value: m.value, context: m.context }))).toEqual([
      { uuid: "a", value: 60, context: 80 },
      { uuid: "b", value: 0, context: 0 },
    ]);
  });
});

describe("bar height and context line", () => {
  const mk = (value: number, context = 0): Mark =>
    ({ uuid: String(value) + ":" + context, kind: "assistant", turnSeq: 1, t: 0, durationMs: 0, value, context, error: false, finding: null, fileChange: false, fileChangeCount: 0, spawn: false }) as Mark;
  const opts = (reference: number, usagePresent = true) => ({ reference, usagePresent, plotH: 44, minH: 3 });

  it("references the 95th percentile of non-zero values, not the max", () => {
    const marks = [0, ...Array.from({ length: 20 }, (_, i) => i + 1)].map((v) => mk(v));
    expect(heightReference(marks)).toBe(20); // floor(20 * 0.95) = 19 → the 20th value
    expect(heightReference([...Array.from({ length: 99 }, () => mk(1)), mk(10_000)])).toBe(1);
    expect(heightReference([mk(0), mk(0)])).toBe(0);
  });

  it("sqrt-scales against the reference, clamps at full height, keeps a minimum", () => {
    expect(barHeight(100, opts(100))).toBe(44);
    expect(barHeight(10_000, opts(100))).toBe(44);
    expect(barHeight(25, opts(100))).toBeCloseTo(22);
    expect(barHeight(0, opts(100))).toBe(3);
    expect(barHeight(0.0001, opts(100))).toBe(3);
  });

  it("draws every bar at 60% when the session has no usage", () => {
    expect(barHeight(50, opts(100, false))).toBeCloseTo(26.4);
    expect(barHeight(50, opts(0))).toBeCloseTo(26.4);
  });

  it("normalises the context line against the session's own peak and skips marks without usage", () => {
    const marks = [mk(1, 100), mk(2, 0), mk(3, 50)];
    const xs = new Map([[marks[0], 10], [marks[2], 30.25]]);
    expect(contextLine(marks, (m) => xs.get(m) ?? -1, 44)).toEqual({ peak: 100, points: "10.0,0.0 30.3,22.0" });
    expect(contextLine([mk(1), mk(2)], () => 0, 44)).toEqual({ peak: 0, points: "" });
  });
});
