/**
 * Every chart card carries a "how to read this" guide, and this is what keeps it that way.
 *
 * The guide is the only place a reader learns what the axis units are and which caveats decide
 * whether a reading is fair. A new chart shipped without one looks completely fine — it just leaves
 * that reader guessing, which is the state this whole affordance exists to fix.
 */
import { describe, expect, it } from "vitest";
import { render as rtlRender, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import { CHART_REGISTRY } from "../src/dashboard/registry";

// Recharts' ResponsiveContainer observes its box on mount; jsdom has no ResizeObserver. The charts
// then measure 0x0 and draw nothing, which is fine — this suite asserts the card header, not marks.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver;

import type { ChartProps } from "../src/dashboard/charts/common";

/** Several cards deep-link into the Sessions view, so they need a router in context. */
const render = (ui: ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);

const noopExpand: ChartProps["expand"] = {
  topN: (d: readonly unknown[]) => d as never,
  expandHeight: () => undefined,
  expandBtn: () => null,
} as never;

const props: ChartProps = {
  hidden: false,
  ts: null,
  bd: null,
  time: null,
  expand: noopExpand,
  drill: { drillFilter: () => {}, drillTo: () => () => {} } as never,
};

describe("every dashboard chart explains how to read itself", () => {
  for (const { id, label, Component } of CHART_REGISTRY) {
    it(`${id} has a guide naming its units`, () => {
      render(<Component {...props} />);
      const summary = screen.getByLabelText(`How to read "${label}"`);
      expect(summary, `${id}: no ⓘ disclosure in the card header`).toBeTruthy();

      // The panel is in the DOM whether or not <details> is open, so its text is assertable directly.
      const body = summary.closest("details")?.querySelector(".card-guide-body");
      const text = body?.textContent ?? "";
      expect(text.length, `${id}: guide is too thin to be worth opening`).toBeGreaterThan(120);
      // Every chart plots *something* against *something*; say what, in the reader's words.
      expect(text, `${id}: guide never says what the axes or bars represent`).toMatch(/axis|bar length|cell value|rows \/ columns/i);
      cleanup();
    });
  }

  it("card titles and registry labels agree, so the guide's accessible name is findable", () => {
    for (const { id, label, Component } of CHART_REGISTRY) {
      render(<Component {...props} />);
      expect(screen.getByRole("heading", { name: label }), `${id}: card title differs from its registry label`).toBeTruthy();
      cleanup();
    }
  });
});
