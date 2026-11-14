/**
 * /security — how each finding's tool call was approved (ADR-040): the Approved column labels it, says
 * "not recorded" rather than guessing, and the approval filter goes to the API as `approval=`.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FindingListRow, SecuritySummary } from "../src/api";

const api = vi.fn();
vi.mock("../src/api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/api");
  return { ...actual, api: (...args: unknown[]) => api(...args), SNAPSHOT: false };
});

import SecurityView from "../src/SecurityView";

afterEach(() => {
  cleanup();
  api.mockReset();
});

const row = (id: string, permission: FindingListRow["permission"]): FindingListRow => ({
  id,
  session_id: "sess1",
  tool_call_id: `tc-${id}`,
  event_uuid: null,
  turn_id: null,
  rule_id: "destructive.rm_rf",
  category: "destructive",
  framework_ref: null,
  severity: "high",
  title: "Recursive delete",
  evidence: "rm -rf build",
  tool_name: "Bash",
  session_title: "A session",
  permission,
});

const summary: SecuritySummary = { total: 2, sessions_flagged: 1, dismissed: 0, muted: 0, by_severity: [], by_category: [], by_rule: [], categories: [] };

function serve() {
  api.mockImplementation(async (path: string) => {
    if (path.startsWith("/security/summary")) return summary;
    if (path.startsWith("/security/findings"))
      return {
        total: 2,
        findings: [row("f1", { decision: "reject", via: "hook", scope: null, rule_source: null, reason: "hook:PreToolUse" }), row("f2", null)],
      };
    return [];
  });
}

const findingCalls = () => api.mock.calls.map((c) => String(c[0])).filter((p) => p.startsWith("/security/findings"));

describe("Security view approval", () => {
  it("labels each finding's approval, and says when it was not recorded", async () => {
    serve();
    render(
      <MemoryRouter>
        <SecurityView />
      </MemoryRouter>,
    );
    await screen.findByText("rejected by hook");
    const table = within(screen.getByRole("table"));
    expect(table.getByText("rejected by hook").className).toContain("perm-reject");
    expect(table.getByText("not recorded")).toBeTruthy();
  });

  it("sends the approval filter to the API", async () => {
    serve();
    render(
      <MemoryRouter>
        <SecurityView />
      </MemoryRouter>,
    );
    await screen.findByText("rejected by hook");
    fireEvent.change(screen.getByLabelText("Filter by how the call was approved"), { target: { value: "rejected" } });
    await waitFor(() => expect(findingCalls().some((p) => p.includes("approval=rejected"))).toBe(true));
  });
});
