import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRow, type AgentRowData } from "../src/AgentRow";

afterEach(cleanup);

const base: AgentRowData = {
  id: "abcdef0123456789",
  title: "derived title",
  agent_description: null,
  agent_type: null,
  spawn_depth: null,
  models: "claude-opus-4-20250101",
  tokens: 12345,
  cost: 0.42,
};

function renderRow(a: Partial<AgentRowData>) {
  render(
    <MemoryRouter>
      <ul>
        <AgentRow a={{ ...base, ...a }} />
      </ul>
    </MemoryRouter>,
  );
  return screen.getByRole("listitem");
}

describe("AgentRow", () => {
  it("prefers the sidecar description over the derived title", () => {
    renderRow({ agent_description: "review the auth flow" });
    expect(screen.getByRole("link").textContent).toBe("review the auth flow");
  });

  it("falls back to the title, then to a short id", () => {
    renderRow({});
    expect(screen.getByRole("link").textContent).toBe("derived title");
    cleanup();
    renderRow({ title: null });
    expect(screen.getByRole("link").textContent).toBe("abcdef012345");
  });

  it("links to the agent's own transcript", () => {
    renderRow({});
    expect(screen.getByRole("link").getAttribute("href")).toBe("/session/abcdef0123456789");
  });

  it("shows the agent type when the sidecar carried one", () => {
    const row = renderRow({ agent_type: "Explore" });
    expect(row.querySelector(".meta-type")?.textContent).toBe("Explore");
  });

  it("shows nesting depth only below the top level", () => {
    expect(renderRow({ spawn_depth: 1 }).querySelector(".meta-depth")).toBe(null);
    cleanup();
    expect(renderRow({ spawn_depth: 3 }).querySelector(".meta-depth")?.textContent).toBe("↳3");
  });

  it("renders an em-dash when no model was recorded", () => {
    expect(renderRow({ models: null }).textContent).toContain("· — ·");
  });

  it("appends a duration only when the payload has one", () => {
    expect(renderRow({ duration_ms: 90_000 }).textContent).toMatch(/· 2m$/);
    cleanup();
    expect(renderRow({}).textContent).toMatch(/\$0\.42$/);
  });
});
