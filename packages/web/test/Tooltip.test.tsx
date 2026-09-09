/**
 * The app's tooltip layer replaced ~90 native `title=` hints, so its contract is worth pinning: a
 * hover only counts after the dwell (a mouse crossing a dense stat row must not flash tips), focus
 * shows one straight away, and the hint mirrors into aria-describedby for as long as it is up —
 * without becoming the element's accessible name.
 */
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipLayer } from "../src/Tooltip";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function show() {
  render(
    <>
      <TooltipLayer />
      <button data-tip="Copies the raw archive path">⧉</button>
      <span data-testid="plain">no hint here</span>
    </>,
  );
  return screen.getByRole("button");
}

const tip = () => screen.queryByRole("tooltip");

describe("TooltipLayer", () => {
  it("shows a hovered element's hint only after the dwell delay", () => {
    const btn = show();
    fireEvent.mouseOver(btn);
    expect(tip()).toBeNull();
    act(() => void vi.advanceTimersByTime(400));
    expect(tip()?.textContent).toBe("Copies the raw archive path");
  });

  it("shows immediately on keyboard focus, and hides on blur", () => {
    const btn = show();
    fireEvent.focusIn(btn);
    expect(tip()?.textContent).toBe("Copies the raw archive path");
    fireEvent.focusOut(btn);
    expect(tip()).toBeNull();
  });

  it("describes the anchor while shown, and cleans the attribute up after", () => {
    const btn = show();
    fireEvent.focusIn(btn);
    expect(btn.getAttribute("aria-describedby")).toBe("app-tooltip");
    fireEvent.focusOut(btn);
    expect(btn.getAttribute("aria-describedby")).toBeNull();
  });

  it("hides on Escape and when the pointer moves to an element with no hint", () => {
    const btn = show();
    fireEvent.focusIn(btn);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(tip()).toBeNull();

    fireEvent.focusIn(btn);
    expect(tip()).not.toBeNull();
    fireEvent.mouseOver(screen.getByTestId("plain"));
    expect(tip()).toBeNull();
  });
});
