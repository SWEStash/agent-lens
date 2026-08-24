/**
 * The timeline band's selection filters the transcript.
 *
 * Range lives in the URL (`?from=&to=`) beside `?q=`, so a narrowed view is shareable. Two rules earn
 * their own tests because getting either wrong makes a message unreachable: an event with no
 * timestamp is NEVER filtered out (it cannot be placed on the axis, so a filter would hide it
 * permanently), and a `#ev-` deep link into a message outside the range clears the range rather than
 * scrolling to something the filter is hiding.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail } from "../src/api";

const api = vi.fn();
vi.mock("../src/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: (path: string) => api(path) }));

vi.mock("../src/transcript/viewPrefs", () => ({
  fetchViewPrefs: () => Promise.resolve({}),
  loadFormat: () => "markdown",
  loadHideTools: () => false,
  loadAxisMode: () => "compressed",
  loadTimelineMetric: () => "work",
  saveFormat: () => {},
  saveHideTools: () => {},
  saveAxisMode: () => {},
  saveTimelineMetric: () => {},
}));

const { default: SessionView } = await import("../src/SessionView");

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

const event = (uuid: string, turnId: string, timestamp: string | null) => ({
  uuid,
  session_id: "s1",
  turn_id: turnId,
  seq: 0,
  type: "assistant",
  role: "assistant",
  timestamp,
  model: null,
  is_sidechain: 0,
  is_meta: 0,
  text: `body of ${uuid}`,
  thinking: null,
  toolCalls: [],
});

/** A message whose only content is a tool call — the kind "hide tool messages" removes entirely. */
const toolEvent = (uuid: string, turnId: string, timestamp: string) => ({
  ...event(uuid, turnId, timestamp),
  text: null,
  toolCalls: [
    {
      id: `${uuid}-tc`,
      tool_name: "Bash",
      skill_name: null,
      skill_id: null,
      agent_type: null,
      spawned_session_id: null,
      workflow_run_id: null,
      workflow_name: null,
      workflow_agent_count: null,
      status: "ok",
      total_duration_ms: null,
      input_json: JSON.stringify({ command: "ls -la" }),
      result_summary: "total 0",
      findings: [],
    },
  ],
});

/** Three timestamped messages ten minutes apart, plus one with no timestamp at all. */
function detail(): SessionDetail {
  return {
    session: { id: "s1", ai_title: "T", started_at: null, ended_at: null, duration_ms: null },
    turns: [turn(0), turn(1)],
    events: [
      event("early", "s1:0", "2026-01-01T10:00:00Z"),
      event("mid", "s1:0", "2026-01-01T10:10:00Z"),
      event("late", "s1:1", "2026-01-01T10:20:00Z"),
      event("undated", "s1:1", null),
      toolEvent("toolonly", "s1:1", "2026-01-01T10:25:00Z"),
    ],
    children: [],
    workflow_runs: [],
    parent: null,
    file_changes: [],
    findings: [],
  } as unknown as SessionDetail;
}

function renderAt(search: string, hash = "") {
  return render(
    <MemoryRouter initialEntries={[`/session/s1${search}${hash}`]}>
      <Routes>
        <Route path="/session/:id" element={<SessionView />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  api.mockReset();
  api.mockResolvedValue(detail());
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

const RANGE = "?from=2026-01-01T09:55:00.000Z&to=2026-01-01T10:12:00.000Z";

describe("timeline range filter", () => {
  it("shows every message when no range is set", async () => {
    renderAt("");
    await waitFor(() => expect(screen.getByText("body of early")).toBeTruthy());
    expect(screen.getByText("body of mid")).toBeTruthy();
    expect(screen.getByText("body of late")).toBeTruthy();
  });

  it("hides messages outside the range and keeps the ones inside", async () => {
    renderAt(RANGE);
    await waitFor(() => expect(screen.getByText("body of early")).toBeTruthy());
    expect(screen.getByText("body of mid")).toBeTruthy();
    expect(screen.queryByText("body of late")).toBeNull();
  });

  it("never filters out an event that has no timestamp", async () => {
    // It cannot be placed on the axis, so hiding it would make it permanently unreachable.
    renderAt(RANGE);
    await waitFor(() => expect(screen.getByText("body of undated")).toBeTruthy());
  });

  it("states the range and the surviving count", async () => {
    renderAt(RANGE);
    // 3 of 5: early, mid, and the undated one that is never filtered.
    await waitFor(() => expect(screen.getByText(/showing 3 of 5 messages/i)).toBeTruthy());
  });

  it("offers zoom and clear, and clearing restores every message", async () => {
    renderAt(RANGE);
    const clear = await screen.findByRole("button", { name: /clear/i });
    expect(screen.getByRole("button", { name: /zoom/i })).toBeTruthy();
    clear.click();
    await waitFor(() => expect(screen.getByText("body of late")).toBeTruthy());
  });

  it("a turn header counts what the filter left, against its real total", async () => {
    renderAt(RANGE);
    // Turn 1 holds `late` and `toolonly` (both filtered out) and `undated` (kept).
    await waitFor(() => expect(screen.getByText(/1 of 3/)).toBeTruthy());
  });

  it("reports an empty range rather than showing a blank pane", async () => {
    renderAt("?from=2026-01-01T23:00:00.000Z&to=2026-01-01T23:30:00.000Z");
    // `undated` survives any range, so the turn body is never truly empty — the pill still has to
    // describe the filter honestly.
    await waitFor(() => expect(screen.getByText(/showing 1 of 5 messages/i)).toBeTruthy());
  });
});

describe("deep link into a filtered-out message", () => {
  it("clears the range so the link lands, and says why", async () => {
    renderAt(RANGE, "#ev-late");
    await waitFor(() => expect(screen.getByText("body of late")).toBeTruthy());
    expect(screen.getByText(/range cleared to show the linked message/i)).toBeTruthy();
    await waitFor(() => expect(document.querySelector("#ev-late.ev-flagged")).toBeTruthy());
  });

  it("leaves the range alone when the target is already inside it", async () => {
    renderAt(RANGE, "#ev-mid");
    await waitFor(() => expect(screen.getByText("body of mid")).toBeTruthy());
    expect(screen.queryByText(/range cleared/i)).toBeNull();
    expect(screen.queryByText("body of late")).toBeNull();
  });
});

describe("jumping to a message that \"hide tool messages\" is burying", () => {
  it("reveals a tool-only message so the jump has something to land on", async () => {
    // Without this, clicking its timeline mark scrolls to an element that was never rendered and the
    // jump silently does nothing. The same reasoning already applies to find-in-session hits.
    renderAt("", "#ev-toolonly");
    const hideTools = await screen.findByRole("button", { name: /hide tool messages/i });
    hideTools.click();

    await waitFor(() => expect(document.querySelector("#ev-toolonly")).toBeTruthy());
    // A different tool-only message would stay hidden — only the jump target is revealed.
    expect(screen.getByText(/ls -la/)).toBeTruthy();
  });
});

