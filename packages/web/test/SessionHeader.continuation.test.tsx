/**
 * A continued session's transcript starts where its original stopped: the history it repeats is shown
 * once, in the original (ADR-038). The header is what tells the reader the earlier part exists and
 * where, so both directions of the link must be there.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionDetail } from "../src/api";
import { SessionHeader } from "../src/transcript/SessionHeader";

afterEach(cleanup);

function detail(over: Partial<SessionDetail>): SessionDetail {
  return {
    session: {
      id: "s1",
      title: "This session",
      source_id: "isf",
      project_path: "/work/demo",
      is_sidechain: 0,
      event_count: 3,
      tokens: 0,
      token_split: { input: 0, output: 0, cache_creation: 0, cache_read: 0 },
      cost: 0,
      unpriced_models: [],
      tool_call_count: 0,
      tool_error_count: 0,
      tool_rejection_count: 0,
      tool_failure_count: 0,
      duration_ms: null,
      started_at: null,
    },
    turns: [],
    events: [],
    classification: null,
    parent: null,
    continued_from: null,
    continued_in: [],
    children: [],
    workflow_runs: [],
    findings: [],
    file_changes: [],
    ...over,
  } as unknown as SessionDetail;
}

const renderHeader = (d: SessionDetail) =>
  render(
    <MemoryRouter>
      <SessionHeader d={d} />
    </MemoryRouter>,
  );

describe("session header: continuation links (ADR-038)", () => {
  it("links a continuation back to the session whose history it starts after", () => {
    renderHeader(detail({ continued_from: { id: "orig-1", title: "Original work" } }));
    expect(screen.getByText(/continues/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Original work" }).getAttribute("href")).toBe("/session/orig-1");
  });

  it("links an original forward to every session that continues it", () => {
    renderHeader(detail({ continued_in: [{ id: "c-1", title: "Next day" }, { id: "c-2", title: null }] }));
    expect(screen.getByText(/continued in/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Next day" }).getAttribute("href")).toBe("/session/c-1");
    expect(screen.getByRole("link", { name: "c-2" }).getAttribute("href")).toBe("/session/c-2");
  });

  it("shows neither when the session is not part of a continuation, or the server predates the field", () => {
    renderHeader(detail({ continued_from: undefined, continued_in: undefined } as unknown as Partial<SessionDetail>));
    expect(screen.queryByText(/continue/i)).toBeNull();
  });
});
