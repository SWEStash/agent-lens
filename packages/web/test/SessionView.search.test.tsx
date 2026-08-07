/**
 * Find-in-session, wired end to end through SessionView.
 *
 * The feature exists because the transcript hides text in two structural ways the browser's own find
 * can't reach: a collapsed turn renders no children at all, and a long body is clamped. So the cases
 * that matter here are the revealing ones — a badge that counts matches nobody can see, ▸ expanding a
 * collapsed turn to land on one, and a clamped body unclamping when it becomes the active match.
 *
 * The inline tint itself is not asserted: it's painted with the CSS Custom Highlight API, which jsdom
 * doesn't implement. That is by design — the counter, badges, expansion and flash all work without it,
 * and this suite pins exactly that.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail } from "../src/api";

const api = vi.fn();
vi.mock("../src/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: (path: string) => api(path) }));

// The transcript's persisted view prefs hit the network on mount; keep this suite to the search logic.
vi.mock("../src/transcript/viewPrefs", () => ({
  fetchViewPrefs: () => Promise.resolve({}),
  loadFormat: () => "raw",
  loadHideTools: () => false,
  saveFormat: () => {},
  saveHideTools: () => {},
}));

const { default: SessionView } = await import("../src/SessionView");

const scrollIntoView = vi.fn();

const LONG_BODY = "needle in the clamped part\n" + "filler line\n".repeat(40);

/** Three turns: one plain match, one match buried in a tool result, one in a clamped body. */
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
  const event = (uuid: string, turnId: string, over: Record<string, unknown> = {}) => ({
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
    ...over,
  });
  return {
    session: { id: "s1", ai_title: "T", started_at: null, ended_at: null, duration_ms: null },
    turns: [turn(0), turn(1), turn(2)],
    events: [
      event("u1", "s1:0", { text: "a needle in plain sight" }),
      event("u2", "s1:0", { text: "nothing to see" }),
      // The match lives only in a tool result — invisible to a body-only search.
      event("u3", "s1:1", { text: "ran a command", toolCalls: [{ tool_name: "Bash", result_summary: "found a NEEDLE here" }] }),
      event("u4", "s1:2", { text: LONG_BODY }),
    ],
    children: [],
    workflow_runs: [],
    parent: null,
    file_changes: [],
    findings: [],
  } as unknown as SessionDetail;
}

function renderAt(url = "/session/s1") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/session/:id" element={<SessionView />} />
      </Routes>
    </MemoryRouter>,
  );
}

const box = () => screen.getByRole("searchbox", { name: /find in this session/i });
const type = (q: string) => fireEvent.change(box(), { target: { value: q } });
const count = () => screen.getByRole("status").textContent;

beforeEach(() => {
  api.mockReset();
  scrollIntoView.mockReset();
  api.mockResolvedValue(detail());
  Element.prototype.scrollIntoView = scrollIntoView; // jsdom doesn't implement it
});
afterEach(cleanup);

describe("find in session", () => {
  it("counts matching messages across bodies and tool results", async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText("a needle in plain sight")).toBeTruthy());
    type("needle");
    // u1 (body), u3 (tool result), u4 (clamped body) — case-insensitively, and u2 not at all.
    await waitFor(() => expect(count()).toBe("1 of 3 messages"));
  });

  it("says so when nothing matches, and stays quiet under two characters", async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText("a needle in plain sight")).toBeTruthy());
    type("absent");
    await waitFor(() => expect(count()).toBe("No matches"));
    // A one-character query would match nearly every message; it must not search at all.
    type("n");
    await waitFor(() => expect(count()).toBe(""));
  });

  it("steps through matches with ▸ and wraps around", async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText("a needle in plain sight")).toBeTruthy());
    type("needle");
    await waitFor(() => expect(count()).toBe("1 of 3 messages"));

    const next = screen.getByRole("button", { name: /next match/i });
    fireEvent.click(next);
    await waitFor(() => expect(count()).toBe("2 of 3 messages"));
    fireEvent.click(next);
    await waitFor(() => expect(count()).toBe("3 of 3 messages"));
    fireEvent.click(next);
    await waitFor(() => expect(count()).toBe("1 of 3 messages"));

    fireEvent.click(screen.getByRole("button", { name: /previous match/i }));
    await waitFor(() => expect(count()).toBe("3 of 3 messages"));
  });

  it("scrolls to the active match and flashes it", async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText("a needle in plain sight")).toBeTruthy());
    type("needle");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    await waitFor(() => expect(document.querySelector("#ev-u1.ev-flagged")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /next match/i }));
    await waitFor(() => expect(document.querySelector("#ev-u3.ev-flagged")).toBeTruthy());
  });

  it("badges a collapsed turn with its hidden match count, and ▸ expands it to reach one", async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText("a needle in plain sight")).toBeTruthy());

    screen.getByRole("button", { name: /collapse all/i }).click();
    await waitFor(() => expect(screen.queryByText("a needle in plain sight")).toBeNull());

    type("needle");
    // Nothing is rendered to search visually, so the header badges are the only signal: turn 0 holds
    // one match, turn 1 one, turn 2 one.
    await waitFor(() => expect(count()).toBe("1 of 3 messages"));
    const badges = [...document.querySelectorAll(".turn-matches")].map((n) => n.textContent);
    expect(badges).toEqual(["1", "1", "1"]);

    // Landing on the first hit must have opened its turn.
    await waitFor(() => expect(screen.getByText("a needle in plain sight")).toBeTruthy());
  });

  it("unclamps a long body when it becomes the active match", async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText("a needle in plain sight")).toBeTruthy());
    const clamped = () => document.querySelector("#ev-u4 .text-wrap");
    expect(clamped()?.className).toContain("is-clamped");

    type("needle");
    await waitFor(() => expect(count()).toBe("1 of 3 messages"));
    expect(clamped()?.className).toContain("is-clamped"); // not the active match yet

    const next = screen.getByRole("button", { name: /next match/i });
    fireEvent.click(next);
    fireEvent.click(next);
    await waitFor(() => expect(count()).toBe("3 of 3 messages"));
    await waitFor(() => expect(clamped()?.className).not.toContain("is-clamped"));
  });

  it("picks up a term handed over from the sessions list in ?q=", async () => {
    renderAt("/session/s1?q=needle");
    await waitFor(() => expect(screen.getByText("a needle in plain sight")).toBeTruthy());
    expect((box() as HTMLInputElement).value).toBe("needle");
    await waitFor(() => expect(count()).toBe("1 of 3 messages"));
    // …and goes straight to the first match rather than leaving the reader at the top.
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });

  it("focuses the box on / and clears on Escape", async () => {
    renderAt("/session/s1?q=needle");
    await waitFor(() => expect(count()).toBe("1 of 3 messages"));

    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document, { key: "/" });
    expect(document.activeElement).toBe(box());

    fireEvent.keyDown(box(), { key: "Escape" });
    await waitFor(() => expect((box() as HTMLInputElement).value).toBe(""));
    await waitFor(() => expect(count()).toBe(""));
  });
});
