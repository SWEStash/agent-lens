import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useResetOn } from "../src/useResetOn";

afterEach(cleanup);

describe("useResetOn", () => {
  it("holds a value while the key is stable", () => {
    const { result, rerender } = renderHook(({ k }) => useResetOn(k, 1), { initialProps: { k: "a" } });
    expect(result.current[0]).toBe(1);

    act(() => result.current[1](3));
    expect(result.current[0]).toBe(3);

    rerender({ k: "a" });
    expect(result.current[0]).toBe(3);
  });

  it("has reset by the time the key change is committed — no stale value is ever painted", () => {
    const { result, rerender } = renderHook(({ k }) => useResetOn(k, 1), { initialProps: { k: "a" } });

    act(() => result.current[1](7));
    expect(result.current[0]).toBe(7);

    rerender({ k: "b" });
    // The whole point: the committed render under the new key already shows 1. An effect-based reset
    // would have committed (and painted) 7 against the new key before correcting itself.
    expect(result.current[0]).toBe(1);
  });

  it("supports functional updates", () => {
    const { result, rerender } = renderHook(({ k }) => useResetOn(k, 10), { initialProps: { k: "a" } });
    act(() => result.current[1]((n) => n + 5));
    expect(result.current[0]).toBe(15);

    // After a key change the state is back at `initial`, so the updater starts from there.
    rerender({ k: "b" });
    act(() => result.current[1]((n) => n + 5));
    expect(result.current[0]).toBe(15);
  });

  it("returning to a previous key does not resurrect its old value", () => {
    const { result, rerender } = renderHook(({ k }) => useResetOn(k, 0), { initialProps: { k: "a" } });
    act(() => result.current[1](42));
    rerender({ k: "b" });
    expect(result.current[0]).toBe(0);
    rerender({ k: "a" });
    expect(result.current[0]).toBe(0);
  });

  it("works with a reference type without sharing the initial instance", () => {
    const { result, rerender } = renderHook(({ k }) => useResetOn<Set<string>>(k, new Set()), { initialProps: { k: "a" } });
    act(() => result.current[1](new Set(["x"])));
    expect([...result.current[0]]).toEqual(["x"]);
    rerender({ k: "b" });
    expect([...result.current[0]]).toEqual([]);
  });
});
