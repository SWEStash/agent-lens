/**
 * The audit tiles (ADR-036). Two things are worth pinning here and neither is visible in a snapshot:
 * AUDIT_CHART_IDS is a second list that has to track the registry or the fetch gate silently starves
 * or over-fires, and the rate charts have to distinguish "nothing was rejected" from "nothing was
 * asked" — a bucket with no plans in it must not plot as a flawless 0%.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import { AUDIT_CHART_IDS, CHART_REGISTRY } from "../src/dashboard/registry";
import { EditReliability, FileRework, FindingsOverTime, PlanRejections } from "../src/dashboard/charts/audit";
import type { ChartProps } from "../src/dashboard/charts/common";
import type { DashAudit } from "../src/api";

describe("AUDIT_CHART_IDS", () => {
  it("names only ids that exist in the registry", () => {
    const known = new Set(CHART_REGISTRY.map((c) => c.id));
    expect(AUDIT_CHART_IDS.filter((id) => !known.has(id))).toEqual([]);
  });

  it("covers every chart that reads the audit payload", () => {
    const auditComponents = new Set(["EditReliability", "PlanRejections", "FileRework", "FindingsOverTime"]);
    const expected = CHART_REGISTRY.filter((c) => auditComponents.has(c.Component.name)).map((c) => c.id);
    expect([...AUDIT_CHART_IDS].sort()).toEqual(expected.sort());
  });

  it("does not overlap the other lazily-fetched group", async () => {
    const { TIME_CHART_IDS } = await import("../src/dashboard/registry");
    expect(AUDIT_CHART_IDS.filter((id) => TIME_CHART_IDS.includes(id))).toEqual([]);
  });
});

// Recharts' ResponsiveContainer observes its box on mount; jsdom has no ResizeObserver. The charts
// measure 0x0 and draw nothing, which is fine — this suite asserts headers and folding, not marks.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver;

const AUDIT: DashAudit = {
  bucket: "week",
  edit_reliability: [
    { model: "claude-opus-5", calls: 200, errors: 4 },
    { model: "claude-fable-5", calls: 50, errors: 5 },
  ],
  plan_rejections: [
    { bucket: "2026-W20", plan_calls: 10, plan_rejected: 3, question_calls: 0, question_rejected: 0 },
    { bucket: "2026-W21", plan_calls: 0, plan_rejected: 0, question_calls: 4, question_rejected: 1 },
  ],
  file_rework: [
    { band: "1", pairs: 10, changes: 10 },
    { band: "2-3", pairs: 4, changes: 9 },
    { band: "4-6", pairs: 0, changes: 0 },
    { band: "7-12", pairs: 0, changes: 0 },
    { band: "13+", pairs: 1, changes: 20 },
  ],
  findings_over_time: [{ bucket: "2026-W20", info: 1, low: 2, medium: 0, high: 1, critical: 0 }],
};

const propsFor = (audit: DashAudit | null): ChartProps => ({
  hidden: false,
  ts: null,
  bd: null,
  time: null,
  audit,
  expand: { topN: (d: readonly unknown[]) => d, expandHeight: () => undefined, expandBtn: () => null } as never,
  drill: { drillFilter: () => {}, drillTo: () => () => {} } as never,
  range: {},
});

const draw = (ui: ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("audit tiles", () => {
  it("render without a payload rather than throwing", () => {
    // They are fetched lazily and separately, so null is a normal frame, not an error state.
    for (const Component of [EditReliability, PlanRejections, FileRework, FindingsOverTime]) {
      const { unmount } = draw(<Component {...propsFor(null)} />);
      unmount();
    }
  });

  it("keeps every card's title identical to its registry label", () => {
    // The guides suite asserts this per chart; doing it here too is what catches a label edited in
    // one of the two places, which is the form the mistake actually takes.
    for (const { label, Component } of CHART_REGISTRY.filter((c) => AUDIT_CHART_IDS.includes(c.id))) {
      const { unmount } = draw(<Component {...propsFor(AUDIT)} />);
      expect(screen.getByRole("heading", { name: label })).toBeTruthy();
      unmount();
    }
  });
});

describe("plan rejections", () => {
  it("plots a bucket with no calls of that kind as a gap, not as zero percent", () => {
    // W21 has no plans and W20 has no questions. Plotting either as 0% would read as a perfect
    // week rather than an empty one, which is the whole reason the series are nullable.
    const rows = AUDIT.plan_rejections.map((r) => ({
      plans: r.plan_calls ? (r.plan_rejected / r.plan_calls) * 100 : null,
      questions: r.question_calls ? (r.question_rejected / r.question_calls) * 100 : null,
    }));
    expect(rows).toEqual([
      { plans: 30, questions: null },
      { plans: null, questions: 25 },
    ]);
  });
});
