import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { useQueryState } from "../src/useQueryState";

afterEach(cleanup);

/** Renders the hook inside a router seeded with `search`, and exposes the resulting URL query. */
function renderQueryState(search: string, resetOnChange?: string[]) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(MemoryRouter, { initialEntries: [search] }, children);
  return renderHook(
    () => ({
      q: useQueryState(resetOnChange),
      search: useLocation().search,
    }),
    { wrapper },
  );
}

describe("useQueryState", () => {
  it("reads a param, with a fallback for a missing one", () => {
    const { result } = renderQueryState("/?source=cli");
    expect(result.current.q.get("source")).toBe("cli");
    expect(result.current.q.get("project")).toBe("");
    expect(result.current.q.get("status", "open")).toBe("open");
  });

  it("sets and deletes params, keeping the rest of the query", () => {
    const { result } = renderQueryState("/?source=cli&q=hi");
    act(() => result.current.q.set({ project: "p1" }));
    expect(result.current.search).toBe("?source=cli&q=hi&project=p1");

    act(() => result.current.q.set({ q: "" }));
    expect(result.current.search).toBe("?source=cli&project=p1");
  });

  it("patches several params at once", () => {
    const { result } = renderQueryState("/?category=c1&rule=r1");
    act(() => result.current.q.set({ category: "c2", rule: "" }));
    expect(result.current.search).toBe("?category=c2");
  });

  it("drops the declared reset keys on any other change", () => {
    const { result } = renderQueryState("/?offset=100&source=cli", ["offset"]);
    act(() => result.current.q.set({ source: "sdk" }));
    expect(result.current.search).toBe("?source=sdk");
  });

  it("keeps a reset key the patch sets explicitly", () => {
    const { result } = renderQueryState("/?offset=100&source=cli", ["offset"]);
    act(() => result.current.q.set({ offset: "200" }));
    expect(result.current.search).toBe("?offset=200&source=cli");
  });

  it("deletes a reset key set to an empty value (page 1)", () => {
    const { result } = renderQueryState("/?offset=100", ["offset"]);
    act(() => result.current.q.set({ offset: "" }));
    expect(result.current.search).toBe("");
  });

  it("picks only the listed params that have a value", () => {
    const { result } = renderQueryState("/?source=cli&q=hi&project=&other=x");
    expect(result.current.q.pick(["source", "project", "q"]).toString()).toBe("source=cli&q=hi");
  });

  it("clears the whole query", () => {
    const { result } = renderQueryState("/?source=cli&q=hi&offset=50");
    act(() => result.current.q.clear());
    expect(result.current.search).toBe("");
  });

  it("keeps `set` referentially stable across renders", () => {
    const { result, rerender } = renderQueryState("/?a=1", ["offset"]);
    const first = result.current.q.set;
    rerender();
    expect(result.current.q.set).toBe(first);
  });
});
