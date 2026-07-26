import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilterSelect } from "../src/FilterSelect";

afterEach(cleanup);

const OPTIONS = [
  { value: "", label: "all projects" },
  { value: "p1", label: "agent-lens" },
  { value: "p2", label: "swestash" },
];

function open(onChange = vi.fn()) {
  render(
    <div>
      <FilterSelect ariaLabel="Filter by project" value="" options={OPTIONS} onChange={onChange} />
      <button data-testid="outside">elsewhere</button>
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Filter by project" }));
  return onChange;
}

describe("FilterSelect", () => {
  it("opens the listbox from the button", () => {
    open();
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("closes on a mousedown outside the control", () => {
    open();
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByRole("listbox")).toBe(null);
  });

  it("stays open when the mousedown lands inside", () => {
    open();
    fireEvent.mouseDown(screen.getByRole("combobox"));
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("filters options by substring and selects with Enter", () => {
    const onChange = open();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "swe" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["swestash"]);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("p2");
    expect(screen.queryByRole("listbox")).toBe(null);
  });

  it("closes on Escape without selecting", () => {
    const onChange = open();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBe(null);
    expect(onChange).not.toHaveBeenCalled();
  });
});
