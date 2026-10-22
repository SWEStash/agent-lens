/**
 * Characterization of the transcript tool blocks (ToolChip, BashBlock, EditBlock, WorkflowLaunchBlock).
 * Written against the pre-ToolShell code and kept unchanged through the extraction, so the shared shell
 * provably renders the same thing: collapsed by default, the header facts, the result, the full-result
 * disclosure, the raw-JSON toggle, and the links that show even while collapsed.
 */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolCall } from "../src/api";
import { ToolChip } from "../src/transcript/tools/ToolChip";
import { BashBlock } from "../src/transcript/tools/BashBlock";
import { EditBlock } from "../src/transcript/tools/EditBlock";
import { WorkflowLaunchBlock } from "../src/transcript/tools/WorkflowLaunchBlock";
import { parseEditInput } from "../src/transcript/parse";

afterEach(cleanup);

function call(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "tc1",
    tool_name: "Read",
    skill_name: null,
    skill_id: null,
    agent_type: null,
    spawned_session_id: null,
    workflow_run_id: null,
    workflow_name: null,
    workflow_agent_count: null,
    status: "ok",
    total_duration_ms: 1500,
    input_json: JSON.stringify({ file_path: "/p/a.ts" }),
    result_summary: "summary text",
    full_result: { text: "the whole output", bytes: 2048 },
    ...over,
  };
}

const ui = (node: React.ReactNode) => render(<MemoryRouter>{node}</MemoryRouter>);
const head = (c: HTMLElement) => c.querySelector("button.tool-head") as HTMLButtonElement;

/** The behaviour every collapsible block shares. */
function sharedShell(name: string, mount: (t: ToolCall) => HTMLElement, resultSelector: string) {
  describe(`${name} — shared shell`, () => {
    it("starts collapsed and toggles open with aria-expanded", () => {
      const c = mount(call());
      expect(head(c).getAttribute("aria-expanded")).toBe("false");
      expect(c.querySelector(".tool-body")).toBeNull();
      fireEvent.click(head(c));
      expect(head(c).getAttribute("aria-expanded")).toBe("true");
      const body = c.querySelector(".tool-body") as HTMLElement;
      expect(body.id).toBe(head(c).getAttribute("aria-controls"));
      fireEvent.click(head(c));
      expect(c.querySelector(".tool-body")).toBeNull();
    });

    it("shows status, duration and the chevron in the header", () => {
      const c = mount(call());
      expect(within(head(c)).getByText("ok").className).toBe("tool-status");
      expect(within(head(c)).getByText("2s")).toBeTruthy();
      expect(within(head(c)).getByText("▸")).toBeTruthy();
      fireEvent.click(head(c));
      expect(within(head(c)).getByText("▾")).toBeTruthy();
    });

    it("marks an errored call", () => {
      expect(mount(call({ status: "error" })).querySelector(".tool")!.className).toContain("tool-err");
      expect(mount(call()).querySelector(".tool")!.className).not.toContain("tool-err");
    });

    it("renders the result and discloses the full result with its size", () => {
      const c = mount(call());
      fireEvent.click(head(c));
      expect(c.querySelector(resultSelector)!.textContent).toBe("summary text");
      const show = within(c).getByRole("button", { name: "Show full result (2.0 KB)" });
      expect(show.getAttribute("aria-expanded")).toBe("false");
      expect(within(c).queryByText("the whole output")).toBeNull();
      fireEvent.click(show);
      expect(within(c).getByText("the whole output")).toBeTruthy();
      expect(within(c).getByRole("button", { name: "Hide full result (2.0 KB)" })).toBeTruthy();
      expect(within(c).getByRole("button", { name: "Copy full tool result" })).toBeTruthy();
    });

    it("omits the result blocks when there is no result", () => {
      const c = mount(call({ result_summary: null, full_result: null }));
      fireEvent.click(head(c));
      expect(c.querySelector(resultSelector)).toBeNull();
      expect(c.querySelector(".full-result")).toBeNull();
    });

    it("leaves duration out when there is none", () => {
      const c = mount(call({ total_duration_ms: null }));
      expect(head(c).querySelector(".muted")).toBeNull();
    });
  });
}

const bash = { command: "ls -la\necho hi", description: "list files" };
const edit = () => parseEditInput("Edit", JSON.stringify({ file_path: "/p/src/a.ts", old_string: "a", new_string: "b" }))!;

sharedShell("ToolChip", (t) => ui(<ToolChip t={t} />).container, ".result");
sharedShell("BashBlock", (t) => ui(<BashBlock t={{ ...t, tool_name: "Bash" }} bash={bash} />).container, ".shell-out");
sharedShell("EditBlock", (t) => ui(<EditBlock t={{ ...t, tool_name: "Edit" }} edit={edit()} />).container, ".shell-out");

describe("ToolChip", () => {
  it("labels skills, workflows and agents", () => {
    expect(within(head(ui(<ToolChip t={call({ skill_name: "tdd" })} />).container)).getByText("🔧 Skill · tdd")).toBeTruthy();
    cleanup();
    expect(within(head(ui(<ToolChip t={call({ tool_name: "Workflow", workflow_name: "wf" })} />).container)).getByText("🔧 Workflow · wf")).toBeTruthy();
    cleanup();
    expect(within(head(ui(<ToolChip t={call({ tool_name: "Task", agent_type: "Explore" })} />).container)).getByText("🔧 Task → Explore")).toBeTruthy();
  });

  it("shows the input JSON when open, and no raw-JSON toggle", () => {
    const c = ui(<ToolChip t={call()} />).container;
    fireEvent.click(head(c));
    expect(c.querySelector(".tool-body pre.code")!.textContent).toContain('"file_path": "/p/a.ts"');
    expect(within(c).getByRole("button", { name: "Copy tool input JSON" })).toBeTruthy();
    expect(within(c).queryByRole("button", { name: /raw JSON/ })).toBeNull();
  });

  it("hides an empty input", () => {
    const c = ui(<ToolChip t={call({ input_json: "{}" })} />).container;
    fireEvent.click(head(c));
    expect(within(c).queryByRole("button", { name: "Copy tool input JSON" })).toBeNull();
  });

  it("links to the subagent, workflow and skill even while collapsed", () => {
    const c = ui(
      <ToolChip t={call({ spawned_session_id: "s9", workflow_run_id: "wf_1", workflow_agent_count: 1, skill_name: "tdd", skill_id: "h1" })} />,
    ).container;
    const hrefs = [...c.querySelectorAll("a.subagent-link")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/session/s9", "/workflow/wf_1", "/skill/tdd?v=h1"]);
    expect(within(c).getByText(/launched 1 agent ·/)).toBeTruthy();
  });
});

describe("BashBlock", () => {
  it("shows the description in the header, or the first command line while collapsed", () => {
    const c = ui(<BashBlock t={call({ tool_name: "Bash" })} bash={bash} />).container;
    expect(within(head(c)).getByText("# list files")).toBeTruthy();
    cleanup();
    const d = ui(<BashBlock t={call({ tool_name: "Bash" })} bash={{ command: "ls -la\necho hi" }} />).container;
    expect(within(head(d)).getByText("ls -la")).toBeTruthy();
    fireEvent.click(head(d));
    expect(head(d).querySelector(".bash-preview")).toBeNull();
  });

  it("renders one $ prompt per command, the flag badges, and the raw JSON toggle", () => {
    const c = ui(<BashBlock t={call({ tool_name: "Bash" })} bash={{ ...bash, run_in_background: true, timeout: 30000 }} />).container;
    fireEvent.click(head(c));
    expect([...c.querySelectorAll(".shell-gutter")].map((g) => g.textContent)).toEqual(["$ ", "$ "]);
    expect([...c.querySelectorAll(".bash-badge")].map((b) => b.textContent)).toEqual(["background", "timeout 30s"]);
    const raw = within(c).getByRole("button", { name: "View raw JSON ▾" });
    expect(c.ownerDocument.getElementById(raw.getAttribute("aria-controls")!)).toBeNull();
    fireEvent.click(raw);
    const json = c.ownerDocument.getElementById(raw.getAttribute("aria-controls")!)!;
    expect(json.textContent).toContain('"file_path": "/p/a.ts"');
    expect(within(c).getByRole("button", { name: "Hide raw JSON ▴" })).toBe(raw);
  });
});

describe("EditBlock", () => {
  it("shows the file, the diff stat and the diff when open", () => {
    const c = ui(<EditBlock t={call({ tool_name: "Edit" })} edit={edit()} />).container;
    expect(within(head(c)).getByText("a.ts")).toBeTruthy();
    expect(within(head(c)).getByText("+1")).toBeTruthy();
    expect(within(head(c)).getByText("−1")).toBeTruthy();
    fireEvent.click(head(c));
    expect([...c.querySelectorAll(".diff-line")].map((l) => l.className)).toEqual(["diff-line del", "diff-line add"]);
    expect(within(c).getByRole("button", { name: "View raw JSON ▾" })).toBeTruthy();
  });
});

describe("WorkflowLaunchBlock", () => {
  it("always shows its name, status, link and result — it does not collapse", () => {
    const c = ui(
      <WorkflowLaunchBlock t={call({ tool_name: "Workflow", workflow_name: "review", workflow_run_id: "wf_2", workflow_agent_count: 3 })} />,
    ).container;
    expect(c.querySelector("button.tool-head")).toBeNull();
    expect(within(c).getByText("🔀 Workflow · review")).toBeTruthy();
    expect(c.querySelector("a.subagent-link")!.getAttribute("href")).toBe("/workflow/wf_2");
    expect(c.querySelector(".result")!.textContent).toBe("summary text");
  });
});
