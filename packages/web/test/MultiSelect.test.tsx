/**
 * Two opposite defaults share this control, and confusing them is the failure mode worth a test:
 * the session filters treat an empty selection as "no filter", while the dashboard's model filter
 * treats a full selection as "no filter". `reset.to` is what tells them apart, so these assert that
 * the count badge and the reset button track the distance from THAT state, not from empty.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MultiSelect } from "../src/MultiSelect";

afterEach(cleanup);

const OPTIONS = [
  { value: "a", label: "opus" },
  { value: "b", label: "haiku" },
  { value: "c", label: "fable" },
];

function show(selected: string[], reset?: { label: string; to: string[] }) {
  const onChange = vi.fn();
  render(<MultiSelect label="Models" options={OPTIONS} selected={selected} onChange={onChange} reset={reset} />);
  return onChange;
}

const summary = () => screen.getByLabelText("Models", { selector: "summary" }).textContent ?? "";
describe("MultiSelect", () => {
  it("reads an empty selection as the default when nothing is ticked by default", () => {
    show([]);
    expect(summary()).not.toContain("(");
    expect(screen.queryByRole("button", { name: "clear" })).toBeNull();
  });

  it("shows the count and the way back once a default-empty control is narrowed", () => {
    const onChange = show(["a"]);
    expect(summary()).toContain("(1)");
    fireEvent.click(screen.getByRole("button", { name: "clear" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("reads a FULL selection as the default when everything is ticked by default", () => {
    // The inverse convention: all three ticked is this control's no-filter state, so it must not
    // announce itself as a filter.
    show(["a", "b", "c"], { label: "select all", to: ["a", "b", "c"] });
    expect(summary()).not.toContain("(");
    expect(screen.queryByRole("button", { name: "select all" })).toBeNull();
  });

  it("offers the way back to everything once a default-full control is narrowed", () => {
    const onChange = show(["a"], { label: "select all", to: ["a", "b", "c"] });
    expect(summary()).toContain("(1)");
    fireEvent.click(screen.getByRole("button", { name: "select all" }));
    expect(onChange).toHaveBeenCalledWith(["a", "b", "c"]);
  });

  it("keeps the last ticked box ticked, since a filter admitting nothing has no encoding", () => {
    show(["a"], { label: "select all", to: ["a", "b", "c"] });
    expect(screen.getByRole("checkbox", { name: "opus" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("checkbox", { name: "haiku" }).hasAttribute("disabled")).toBe(false);
  });

  it("lets a default-empty control be emptied, where empty is a meaningful state", () => {
    show(["a"]);
    expect(screen.getByRole("checkbox", { name: "opus" }).hasAttribute("disabled")).toBe(false);
  });

  it("renders inert when disabled, for a surface that cannot honour the filter", () => {
    // The static snapshot serves one pre-computed response per endpoint and ignores query params,
    // so a live-looking control there would silently do nothing.
    render(<MultiSelect label="Models" options={OPTIONS} selected={["a", "b", "c"]} onChange={vi.fn()} disabled />);
    expect(screen.getAllByRole("checkbox").every((b) => b.hasAttribute("disabled"))).toBe(true);
  });

  it("normalizes a new selection to option order, so the URL does not depend on click order", () => {
    const onChange = show(["c"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "opus" }));
    expect(onChange).toHaveBeenCalledWith(["a", "c"]);
  });
});
