/**
 * The enlarged chart view is the app's only modal dialog, so nothing else in the codebase would
 * catch it regressing: no focus restoration, no trap, no modality, and a keyboard reader who opens a
 * chart is stranded on the page body when they close it.
 *
 * The double-render case is here for a different reason — it looks completely fine on screen. Two
 * live copies of the same chart both measure and redraw, one of them behind an opaque backdrop.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { ChartCard } from "../src/charts/theme";

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver;

/** The dialog puts `inert` on `#root`, so the tests need one to check that it did. */
function renderInRoot(ui: React.ReactElement) {
  const root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);
  return render(ui, { container: root });
}

const card = (
  <ChartCard title="Tokens over time" guide={<p>work tokens per bucket</p>}>
    <div data-testid="plot">the chart</div>
  </ChartCard>
);

beforeEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("expanding a chart card", () => {
  it("offers every card an expand control naming its chart", () => {
    renderInRoot(card);
    expect(screen.getByLabelText('Expand "Tokens over time"')).toBeTruthy();
  });

  it("moves the chart into the dialog rather than rendering it twice", () => {
    renderInRoot(card);
    expect(screen.getAllByTestId("plot")).toHaveLength(1);
    fireEvent.click(screen.getByLabelText('Expand "Tokens over time"'));
    expect(screen.getAllByTestId("plot")).toHaveLength(1);
    expect(screen.getByText("Open in the expanded view.")).toBeTruthy();
  });

  it("labels the dialog with the chart's own title and marks the page inert", () => {
    renderInRoot(card);
    fireEvent.click(screen.getByLabelText('Expand "Tokens over time"'));
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const label = document.getElementById(dialog.getAttribute("aria-labelledby")!);
    expect(label?.textContent).toBe("Tokens over time");
    expect(document.getElementById("root")?.hasAttribute("inert")).toBe(true);
  });

  it("takes focus on open and gives it back to the control that opened it", () => {
    renderInRoot(card);
    const opener = screen.getByLabelText('Expand "Tokens over time"');
    opener.focus();
    fireEvent.click(opener);
    const close = screen.getByLabelText('Close "Tokens over time"');
    expect(document.activeElement).toBe(close);

    fireEvent.click(close);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(document.getElementById("root")?.hasAttribute("inert")).toBe(false);
  });

  it("closes on Escape", () => {
    renderInRoot(card);
    fireEvent.click(screen.getByLabelText('Expand "Tokens over time"'));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cycles Tab inside the dialog instead of walking out of it", () => {
    renderInRoot(card);
    fireEvent.click(screen.getByLabelText('Expand "Tokens over time"'));
    const dialog = screen.getByRole("dialog");
    // Scoped to the dialog: the card behind it renders its own header, inert but still in the DOM.
    const guide = within(dialog).getByLabelText('How to read "Tokens over time"');
    const close = screen.getByLabelText('Close "Tokens over time"');

    // Focus opens on the close button, which is the last stop: Tab wraps to the first.
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(guide);
    // …and Shift+Tab off the first goes back to the last.
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);
  });
});
