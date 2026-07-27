/** The one data-loading hook every view uses. Before this, each view hand-rolled the same
 * `useState` × 3 + `useEffect` block (set loading, clear error, fetch, set data / set error, clear
 * loading), which is where SLOP-015 came from. */
import { useEffect, useState } from "react";
import { api } from "./api";

export interface AsyncState<T> {
  /** The last successful payload. Kept across a reload (and across an error) unless `reset` is set. */
  data: T | null;
  loading: boolean;
  /** The stringified rejection, or null. Cleared when a new load starts. */
  error: string | null;
}

export interface AsyncOptions {
  /** Clear `data` when the deps change, so a detail page shows its loading state instead of the
   * outgoing record. List views want the opposite (keep the old rows under a "Loading…" line). */
  reset?: boolean;
  /** Extra refetch triggers beyond the path — a write that must be reflected (see SecurityView). */
  deps?: unknown[];
}

/** Runs `load` on mount and whenever `deps` change, tracking loading/error. `load` may return null to
 * mean "nothing to fetch" (an empty route param): that just clears `loading`. */
export function useAsync<T>(load: () => Promise<T> | null, deps: unknown[], opts: AsyncOptions = {}): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, error: null });

  useEffect(() => {
    const p = load();
    if (!p) {
      setState((s) => ({ ...s, loading: false, error: null }));
      return;
    }
    setState((s) => ({ data: opts.reset ? null : s.data, loading: true, error: null }));
    // Responses can land out of order (a filter typed quickly enough, a slow first page). Only the
    // newest request may write state: `stale` is set by the cleanup that runs when the deps change.
    let stale = false;
    p.then(
      (data) => !stale && setState({ data, loading: false, error: null }),
      (e) => !stale && setState((s) => ({ data: s.data, loading: false, error: String(e) })),
    );
    return () => {
      stale = true;
    };
    // `load` is an inline closure over the deps; the caller's dep list is authoritative.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}

/** `useAsync` for the common case: GET one API path. A null path means "nothing to fetch". */
export function useFetch<T>(path: string | null, opts?: AsyncOptions): AsyncState<T> {
  return useAsync<T>(() => (path === null ? null : api<T>(path)), [path, ...(opts?.deps ?? [])], opts);
}

/** A fire-and-forget lookup — the filter dropdowns' sources/projects/models. Returns the payload or
 * `fallback` (identity-stable, so it is safe in a dep array); a failed lookup is silent, exactly as
 * the hand-rolled `.catch(() => {})` was, because a missing filter list must not break the page. */
export function useLookup<T>(path: string | null, fallback: T, deps: unknown[] = []): T {
  const [stableFallback] = useState(fallback);
  const { data } = useAsync<T>(() => (path === null ? null : api<T>(path)), [path, ...deps]);
  return data ?? stableFallback;
}
