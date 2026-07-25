import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useDetailsAutoClose } from "../src/useDetailsAutoClose";

afterEach(cleanup);

function Dropdown() {
  const ref = useDetailsAutoClose();
  return (
    <div>
      <details ref={ref} open data-testid="dd">
        <summary>menu</summary>
        <label data-testid="inside">
          <input type="checkbox" /> one
        </label>
      </details>
      <button data-testid="outside">elsewhere</button>
    </div>
  );
}

function mousedown(el: Element) {
  el.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
}

describe("useDetailsAutoClose", () => {
  it("closes on a mousedown outside the <details>", () => {
    render(<Dropdown />);
    const dd = screen.getByTestId("dd") as HTMLDetailsElement;
    expect(dd.open).toBe(true);
    mousedown(screen.getByTestId("outside"));
    expect(dd.open).toBe(false);
  });

  it("stays open when the mousedown lands inside", () => {
    render(<Dropdown />);
    const dd = screen.getByTestId("dd") as HTMLDetailsElement;
    mousedown(screen.getByTestId("inside"));
    expect(dd.open).toBe(true);
  });

  it("detaches its listener on unmount", () => {
    const { unmount } = render(<Dropdown />);
    const dd = screen.getByTestId("dd") as HTMLDetailsElement;
    unmount();
    // No listener left to throw on a null ref.
    mousedown(document.body);
    expect(dd.open).toBe(true);
  });
});
