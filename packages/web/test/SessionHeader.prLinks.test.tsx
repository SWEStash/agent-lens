/**
 * The PRs and branches a session recorded (ADR-041): each PR links out when a URL was recorded, and
 * to the other sessions that touched it. A session with none, or an older server that sends neither
 * field, shows nothing.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionDetail } from "../src/api";
import { SessionHeader } from "../src/transcript/SessionHeader";

afterEach(cleanup);

const GH = "https://github.com/demo/acme-api/pull/42";

function detail(over: Partial<SessionDetail>): SessionDetail {
  return {
    session: {
      id: "s1", title: "This session", source_id: "isf", project_path: "/work/demo", is_sidechain: 0, event_count: 3, tokens: 0,
      token_split: { input: 0, output: 0, cache_creation: 0, cache_read: 0 }, cost: 0, unpriced_models: [],
      tool_call_count: 0, tool_error_count: 0, tool_rejection_count: 0, tool_failure_count: 0, duration_ms: null, started_at: null,
    },
    turns: [], events: [], classification: null, parent: null, continued_from: null, continued_in: [], children: [],
    workflow_runs: [], findings: [], file_changes: [],
    ...over,
  } as unknown as SessionDetail;
}

const renderHeader = (d: SessionDetail) =>
  render(
    <MemoryRouter>
      <SessionHeader d={d} />
    </MemoryRouter>,
  );

describe("session header: PR and branch links (ADR-041)", () => {
  it("links a PR out to its page and to the sessions that touched it", () => {
    renderHeader(detail({
      prs: [{ repository: "demo/acme-api", number: 42, url: GH, first_seen_at: null, opened_here: true }],
      branches: [{ branch: "feat/x", first_pushed_at: null }],
    }));
    const out = screen.getByRole("link", { name: "demo/acme-api#42" });
    expect(out.getAttribute("href")).toBe(GH);
    expect(out.getAttribute("target")).toBe("_blank");
    expect(out.getAttribute("rel")).toContain("noopener");
    expect(screen.getByRole("link", { name: "Sessions that touched demo/acme-api#42" }).getAttribute("href")).toBe(`/?pr=${encodeURIComponent(GH)}`);
    expect(screen.getByText("opened")).toBeTruthy();
    expect(screen.getByText("feat/x")).toBeTruthy();
  });

  it("shows a PR without a recorded URL as text, filtering by owner/repo#n", () => {
    renderHeader(detail({ prs: [{ repository: "repo-ab12", number: 7, url: null, first_seen_at: null, opened_here: false }] }));
    expect(screen.queryByRole("link", { name: "repo-ab12#7" })).toBeNull();
    expect(screen.getByText("repo-ab12#7")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sessions that touched repo-ab12#7" }).getAttribute("href")).toBe(`/?pr=${encodeURIComponent("repo-ab12#7")}`);
    expect(screen.queryByText("opened")).toBeNull();
  });

  it("shows nothing when there are none, or the server predates the fields", () => {
    renderHeader(detail({ prs: [], branches: [] }));
    expect(screen.queryByText(/^PR/)).toBeNull();
    cleanup();
    renderHeader(detail({}));
    expect(screen.queryByText(/^PR/)).toBeNull();
    expect(screen.queryByText(/pushed/)).toBeNull();
  });
});
