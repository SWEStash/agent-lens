/** Filters, sort and paging live in the URL on every list page, so a view is shareable and the back
 * button works. Each page had grown its own copy of "read a param", "patch the query", and "collect
 * the active filters into a query string" — SLOP-045. This is that trio, once. */
import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

export interface QueryState {
  /** The raw params, for the few places that need something the helpers don't cover. */
  params: URLSearchParams;
  /** A param's value, or `fallback` ("" by default) when it is absent. */
  get: (key: string, fallback?: string) => string;
  /** Patch the query — an empty value deletes the key. Keys the view declared as reset-on-change are
   * dropped too, unless the patch sets one explicitly (paging must be able to set its own offset). */
  set: (patch: Record<string, string>) => void;
  /** The listed params that currently have a value, as a query string for the API request. */
  pick: (keys: string[]) => URLSearchParams;
  /** Drop the whole query — the "clear filters" button. */
  clear: () => void;
}

export function useQueryState(resetOnChange: string[] = []): QueryState {
  const [params, setParams] = useSearchParams();
  // Call sites pass an array literal, so its identity changes every render; key `set` off the
  // contents instead, or it would be a new function on each one.
  const resetKeys = resetOnChange.join(",");

  const get = useCallback((key: string, fallback = "") => params.get(key) ?? fallback, [params]);

  const set = useCallback(
    (patch: Record<string, string>) => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      for (const k of resetKeys ? resetKeys.split(",") : []) if (!(k in patch)) next.delete(k);
      setParams(next);
    },
    [params, setParams, resetKeys],
  );

  const pick = useCallback(
    (keys: string[]) => {
      const qs = new URLSearchParams();
      for (const k of keys) {
        const v = params.get(k);
        if (v) qs.set(k, v);
      }
      return qs;
    },
    [params],
  );

  const clear = useCallback(() => setParams(new URLSearchParams()), [setParams]);

  return { params, get, set, pick, clear };
}
