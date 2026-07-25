import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
vi.mock("../src/api", () => ({ api: (path: string) => api(path) }));

const { useAsync, useFetch, useLookup } = await import("../src/useFetch");

/** A promise plus its resolve/reject, so a test can hold a fetch open and assert the loading state. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Block body, not `() => api.mockReset()`: mockReset returns the mock, and vitest treats a value
// returned from a hook as a teardown function — it would then *call* the mock after every test.
beforeEach(() => {
  api.mockReset();
});
afterEach(cleanup);

describe("useFetch", () => {
  it("starts loading, then exposes the payload", async () => {
    const d = deferred<{ n: number }>();
    api.mockReturnValue(d.promise);

    const { result } = renderHook(() => useFetch<{ n: number }>("/sessions"));
    expect(result.current).toEqual({ data: null, loading: true, error: null });

    await act(async () => d.resolve({ n: 1 }));
    expect(result.current).toEqual({ data: { n: 1 }, loading: false, error: null });
    expect(api).toHaveBeenCalledWith("/sessions");
  });

  it("stringifies a rejection into `error` and stops loading", async () => {
    const d = deferred<unknown>();
    api.mockReturnValue(d.promise);

    const { result } = renderHook(() => useFetch("/sessions"));
    await act(async () => { d.reject(new Error("500 boom")); });

    expect(result.current.error).toBe("Error: 500 boom");
    expect(result.current.loading).toBe(false);
  });

  it("keeps the previous payload while reloading and after a failure", async () => {
    const first = deferred<string>();
    api.mockReturnValue(first.promise);
    const { result, rerender } = renderHook(({ p }: { p: string }) => useFetch<string>(p), {
      initialProps: { p: "/a" },
    });
    await act(async () => first.resolve("A"));

    const second = deferred<string>();
    api.mockReturnValue(second.promise);
    rerender({ p: "/b" });
    expect(result.current).toEqual({ data: "A", loading: true, error: null });

    await act(async () => second.reject(new Error("nope")));
    expect(result.current.data).toBe("A");
    expect(result.current.error).toBe("Error: nope");
  });

  it("clears the payload on a dep change when `reset` is set", async () => {
    const first = deferred<string>();
    api.mockReturnValue(first.promise);
    const { result, rerender } = renderHook(({ p }: { p: string }) => useFetch<string>(p, { reset: true }), {
      initialProps: { p: "/a" },
    });
    await act(async () => first.resolve("A"));

    api.mockReturnValue(deferred<string>().promise);
    rerender({ p: "/b" });
    expect(result.current).toEqual({ data: null, loading: true, error: null });
  });

  it("clears a stale error when the next load starts", async () => {
    const first = deferred<string>();
    api.mockReturnValue(first.promise);
    const { result, rerender } = renderHook(({ p }: { p: string }) => useFetch<string>(p), {
      initialProps: { p: "/a" },
    });
    await act(async () => first.reject(new Error("boom")));
    expect(result.current.error).toBe("Error: boom");

    api.mockReturnValue(deferred<string>().promise);
    rerender({ p: "/b" });
    expect(result.current.error).toBe(null);
  });

  it("ignores a stale response that lands after a newer one", async () => {
    const slowFirst = deferred<string>();
    const second = deferred<string>();
    api.mockReturnValueOnce(slowFirst.promise).mockReturnValueOnce(second.promise);

    const { result, rerender } = renderHook(({ p }: { p: string }) => useFetch<string>(p), {
      initialProps: { p: "/a" },
    });
    rerender({ p: "/b" });

    await act(async () => second.resolve("B"));
    await act(async () => slowFirst.resolve("A")); // the superseded request finally answers
    expect(result.current).toEqual({ data: "B", loading: false, error: null });
  });

  it("ignores a stale rejection that lands after a newer response", async () => {
    const slowFirst = deferred<string>();
    const second = deferred<string>();
    api.mockReturnValueOnce(slowFirst.promise).mockReturnValueOnce(second.promise);

    const { result, rerender } = renderHook(({ p }: { p: string }) => useFetch<string>(p), {
      initialProps: { p: "/a" },
    });
    rerender({ p: "/b" });

    await act(async () => second.resolve("B"));
    await act(async () => slowFirst.reject(new Error("timeout")));
    expect(result.current).toEqual({ data: "B", loading: false, error: null });
  });

  it("does not fetch at all when the path is null", async () => {
    const { result } = renderHook(() => useFetch<string>(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api).not.toHaveBeenCalled();
    expect(result.current).toEqual({ data: null, loading: false, error: null });
  });

  it("refetches only when the path changes", async () => {
    api.mockResolvedValue("A");
    const { rerender } = renderHook(({ p }: { p: string }) => useFetch<string>(p), { initialProps: { p: "/a" } });
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    rerender({ p: "/a" });
    expect(api).toHaveBeenCalledTimes(1);
    rerender({ p: "/b" });
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  });
});

describe("useLookup", () => {
  it("returns the fallback until the payload lands, and swallows failures", async () => {
    const d = deferred<string[]>();
    api.mockReturnValue(d.promise);
    const { result } = renderHook(() => useLookup<string[]>("/sources", []));
    expect(result.current).toEqual([]);

    await act(async () => d.resolve(["a"]));
    expect(result.current).toEqual(["a"]);
  });

  it("keeps an identity-stable fallback across renders (safe in a dep array)", async () => {
    api.mockReturnValue(deferred<string[]>().promise);
    const { result, rerender } = renderHook(() => useLookup<string[]>("/sources", []));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("falls back silently when the lookup rejects", async () => {
    const d = deferred<string[]>();
    api.mockReturnValue(d.promise);
    const { result } = renderHook(() => useLookup<string[]>("/sources", []));
    await act(async () => d.reject(new Error("offline")));
    expect(result.current).toEqual([]);
  });

  it("refetches when an extra dep changes", async () => {
    api.mockResolvedValue(["a"]);
    const { rerender } = renderHook(({ k }: { k: number }) => useLookup<string[]>("/mutes", [], [k]), {
      initialProps: { k: 0 },
    });
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    rerender({ k: 1 });
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  });
});

describe("useAsync", () => {
  it("combines several requests into one loading/error state", async () => {
    const { result } = renderHook(() =>
      useAsync(() => Promise.all([Promise.resolve(1), Promise.resolve(2)]), []),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual([1, 2]);
  });

  it("reports the first rejection of a combined load", async () => {
    const { result } = renderHook(() =>
      useAsync(() => Promise.all([Promise.resolve(1), Promise.reject(new Error("two failed"))]), []),
    );
    await waitFor(() => expect(result.current.error).toBe("Error: two failed"));
    expect(result.current.data).toBe(null);
  });
});
