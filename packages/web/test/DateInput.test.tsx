import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { DateInput } from "../src/DateInput";
import { useQueryState } from "../src/useQueryState";

afterEach(cleanup);

function Harness() {
  const { get, set, clear } = useQueryState();
  const { search } = useLocation();
  return (
    <>
      <DateInput value={get("from")} onChange={(v) => set({ from: v })} />
      <output>{search}</output>
      <button onClick={clear}>clear</button>
    </>
  );
}

const field = () => document.querySelector<HTMLInputElement>("input[type=date]")!;

describe("DateInput", () => {
  it("writes the date to the URL", () => {
    render(<MemoryRouter><Harness /></MemoryRouter>);
    fireEvent.change(field(), { target: { value: "2026-03-15" } });
    expect(field().value).toBe("2026-03-15");
    expect(screen.getByRole("status").textContent).toBe("?from=2026-03-15");
  });

  it("follows a change that comes from the URL", () => {
    render(<MemoryRouter initialEntries={["/?from=2026-03-15"]}><Harness /></MemoryRouter>);
    expect(field().value).toBe("2026-03-15");
    act(() => screen.getByRole("button", { name: "clear" }).click());
    expect(field().value).toBe("");
  });
});
