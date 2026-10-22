/**
 * Server prefs answer after first paint. If the user changes a pref in that window, the late answer
 * must not overwrite the choice they just made. One test per reconcile site: the dashboard layout,
 * the sessions column picker, and the transcript view prefs.
 */
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail } from "../src/api";

/** A promise the test resolves by hand, to hold the server answer until after the user acts. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let pending = new Map<string, ReturnType<typeof deferred<unknown>>>();
const fetchPref = vi.fn((key: string) => {
  const d = deferred<unknown>();
  pending.set(key, d);
  return d.promise;
});
vi.mock("../src/prefs", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchPref: (key: string) => fetchPref(key),
  savePref: () => {},
}));

const viewPrefs = deferred<Record<string, unknown>>();
vi.mock("../src/transcript/viewPrefs", () => ({
  fetchViewPrefs: () => viewPrefs.promise,
  loadFormat: () => "markdown",
  loadHideTools: () => false,
  loadAxisMode: () => "compressed",
  loadTimelineMetric: () => "work",
  saveFormat: () => {},
  saveHideTools: () => {},
  saveAxisMode: () => {},
  saveTimelineMetric: () => {},
}));

const api = vi.fn();
vi.mock("../src/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: (path: string) => api(path) }));

const { useDashLayout } = await import("../src/dashboard/useDashLayout");
const { default: SessionsView } = await import("../src/SessionsView");
const { default: SessionView } = await import("../src/SessionView");

beforeEach(() => {
  localStorage.clear();
  pending = new Map();
  api.mockReset();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe("a pref changed before the server answers survives the late answer", () => {
  it("dashboard layout", async () => {
    const { result } = renderHook(() => useDashLayout(["cost"], ["activity"]));
    act(() => result.current.setActive("cost"));
    await act(async () => {
      pending.get("dashboard.layout")!.resolve({ v: 1, active: "all", custom: null, kpisCollapsed: false });
      pending.get("dashboard.charts")!.resolve(null);
    });
    expect(result.current.layout.active).toBe("cost");
  });

  it("sessions column picker", async () => {
    // The column picker lives in the table header, which renders only when there is a row.
    const row = { id: "s1", slug: "one", source_id: "claude", turn_count: 1, finding_count: 0, error_count: 0 };
    api.mockImplementation((p: string) => Promise.resolve(p.startsWith("/sessions") ? { total: 1, sessions: [row] } : []));
    render(
      <MemoryRouter>
        <SessionsView />
      </MemoryRouter>,
    );
    const source = (await screen.findByRole("checkbox", { name: "Source", hidden: true }, { timeout: 5000 })) as HTMLInputElement;
    expect(source.checked).toBe(true);
    act(() => source.click());
    expect(source.checked).toBe(false);
    // The server still has the old choice, with Source visible.
    await act(async () => pending.get("sessions.columns")!.resolve(["source", "project", "turns"]));
    expect((screen.getByRole("checkbox", { name: "Source", hidden: true }) as HTMLInputElement).checked).toBe(false);
  });

  it("transcript view prefs", async () => {
    api.mockResolvedValue({
      session: { id: "s1", ai_title: "T", started_at: null, ended_at: null, duration_ms: null },
      turns: [],
      events: [],
      children: [],
      workflow_runs: [],
      parent: null,
      file_changes: [],
      findings: [],
    } as unknown as SessionDetail);
    render(
      <MemoryRouter initialEntries={["/session/s1"]}>
        <Routes>
          <Route path="/session/:id" element={<SessionView />} />
        </Routes>
      </MemoryRouter>,
    );
    const button = await screen.findByRole("button", { name: /hide tool messages/i }, { timeout: 5000 });
    act(() => button.click());
    await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("true"));
    // The server still says tools are shown.
    await act(async () => viewPrefs.resolve({ hideTools: false }));
    expect(screen.getByRole("button", { name: /hide tool messages/i }).getAttribute("aria-pressed")).toBe("true");
  });
});
