/**
 * Context occupancy on the timeline band. The number itself is the thing to pin: it is the whole
 * prompt the model was sent (input + cache-write + cache-read) and NOT the work-token metric the bars
 * use, so the two must not quietly become the same field.
 */
import { describe, it, expect } from "vitest";
import { buildMarks, contextTokens, metricValue } from "../src/transcript/timeline/marks";
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
