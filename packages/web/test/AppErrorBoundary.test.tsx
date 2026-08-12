/**
 * The boundary that keeps a rebuild from blanking an open tab: a lazy route's chunk is gone, the
 * `import()` rejects, and without this the rejection reaches the root and unmounts everything.
 */
import type React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary, isStaleChunkError } from "../src/AppErrorBoundary";

const reload = vi.fn();

// React re-throws every caught error at the window so devtools can see it; jsdom then dumps the
// whole stack into the test output. These errors are the point of the suite, so swallow them.
window.addEventListener("error", (e) => e.preventDefault());

beforeEach(() => {
  reload.mockClear();
  sessionStorage.clear();
  // jsdom's location.reload is not writable; replace the object wholesale.
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, reload } });
});
afterEach(cleanup);

function Boom({ message }: { message: string }): React.ReactElement {
  throw new Error(message);
}

/** React logs every caught error to console.error; silence it so the run stays readable. */
function renderBoundary(message: string) {
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  render(
    <AppErrorBoundary>
      <Boom message={message} />
    </AppErrorBoundary>,
  );
  quiet.mockRestore();
}

const STALE = "Failed to fetch dynamically imported module: http://127.0.0.1:4477/assets/SessionView-old.js";

describe("isStaleChunkError", () => {
  it.each([
    STALE,
    "error loading dynamically imported module", // Firefox
    "Importing a module script failed.", // Safari
  ])("recognizes %s", (message) => {
    expect(isStaleChunkError(new Error(message))).toBe(true);
  });

  it("leaves an ordinary render error alone", () => {
    expect(isStaleChunkError(new Error("Cannot read properties of undefined"))).toBe(false);
  });
});

describe("AppErrorBoundary", () => {
  it("reloads once when a route chunk is missing", () => {
    renderBoundary(STALE);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("older build");
  });

  it("does not reload again if the reload did not help", () => {
    renderBoundary(STALE);
    cleanup();
    reload.mockClear();
    renderBoundary(STALE);
    expect(reload).not.toHaveBeenCalled(); // a second failure is not staleness — say so instead of looping
    expect(screen.getByRole("alert").textContent).toContain("older build");
  });

  it("shows an ordinary render error without reloading", () => {
    renderBoundary("kaboom");
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("kaboom");
  });
});
