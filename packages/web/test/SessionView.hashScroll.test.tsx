/**
 * Deep-link behaviour of the session transcript.
 *
 * A security finding links to `/session/<id>#ev-<event_uuid>`. Landing there must scroll the flagged
 * message into view and flash it — even when that message sits inside a turn the reader has collapsed,
 * which has to be expanded first.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail } from "../src/api";

const api = vi.fn();
vi.mock("../src/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: (path: string) => api(path) }));

// The transcript's persisted view prefs hit the network on mount; keep this suite to the hash logic.
vi.mock("../src/transcript/viewPrefs", () => ({
  fetchViewPrefs: () => Promise.resolve({}),
  loadFormat: () => "markdown",
  loadHideTools: () => false,
  saveFormat: () => {},
  saveHideTools: () => {},
}));

const { default: SessionView } = await import("../src/SessionView");

const scrollIntoView = vi.fn();

// Two turns, each with one assistant message. `ev-second` is the deep-link target.
function detail(): SessionDetail {
  const turn = (seq: number) => ({
    id: `s1:${seq}`,
    session_id: "s1",
    seq,
    prompt_preview: `turn ${seq}`,
    model: null,
    started_at: null,
    ended_at: null,
    duration_ms: null,
    user_event_uuid: null,
  });
  const event = (uuid: string, turnId: string) => ({
    uuid,
    session_id: "s1",
    turn_id: turnId,
    seq: 0,
    type: "assistant",
    role: "assistant",
    timestamp: "2026-01-01T00:00:00Z",
    model: null,
    is_sidechain: 0,
    is_meta: 0,
    text: `body of ${uuid}`,
    thinking: null,
    toolCalls: [],
  });
  return {
    session: { id: "s1", ai_title: "T", started_at: null, ended_at: null, duration_ms: null },
    turns: [turn(0), turn(1)],
    events: [event("u1", "s1:0"), event("u2", "s1:1")],
    children: [],
    workflow_runs: [],
    parent: null,
    file_changes: [],
    findings: [],
  } as unknown as SessionDetail;
}

function renderAt(hash: string) {
  return render(
    <MemoryRouter initialEntries={[`/session/s1${hash}`]}>
      <Routes>
        <Route path="/session/:id" element={<SessionView />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  api.mockReset();
  scrollIntoView.mockReset();
  api.mockResolvedValue(detail());
  // jsdom implements neither; the component calls both on a successful deep link.
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(cleanup);

describe("SessionView deep-link (#ev-<uuid>)", () => {
  it("scrolls the targeted event into view and flashes it", async () => {
    renderAt("#ev-u2");
    await waitFor(() => expect(screen.getByText("body of u2")).toBeTruthy());
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView.mock.calls[0][0]).toMatchObject({ block: "center" });
    // The flash is React-owned (FlashContext) so it survives the re-render an expansion triggers.
    await waitFor(() => expect(document.querySelector("#ev-u2.ev-flagged")).toBeTruthy());
  });

  it("expands a collapsed turn so a message inside it can be reached", async () => {
    renderAt("#ev-u2");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    scrollIntoView.mockReset();

    // Collapse everything via the toolbar, then confirm the target is really gone from the DOM...
    const toggleAll = await screen.findByRole("button", { name: /collapse all|expand all/i });
    toggleAll.click();
    await waitFor(() => expect(screen.queryByText("body of u2")).toBeNull());

    // ...and that re-entering the same deep link brings it back and scrolls to it again.
    cleanup();
    renderAt("#ev-u2");
    await waitFor(() => expect(screen.getByText("body of u2")).toBeTruthy());
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });

  it("scrolls once per hash, not on every subsequent render", async () => {
    renderAt("#ev-u2");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    const afterFirst = scrollIntoView.mock.calls.length;
    // The flash timeout and its state update cause further renders; none may re-scroll.
    await new Promise((r) => setTimeout(r, 50));
    expect(scrollIntoView.mock.calls.length).toBe(afterFirst);
  });

  it("does nothing without a hash, and ignores an unknown event id", async () => {
    renderAt("");
    await waitFor(() => expect(screen.getByText("body of u1")).toBeTruthy());
    expect(scrollIntoView).not.toHaveBeenCalled();

    cleanup();
    renderAt("#ev-nope-missing");
    await waitFor(() => expect(screen.getByText("body of u1")).toBeTruthy());
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
