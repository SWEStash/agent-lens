import { useCallback, useEffect, useState } from "react";
import { fetchPref, loadPrefLocal, savePref } from "../prefs";
import {
  LAYOUT_PREF_KEY,
  LEGACY_CHARTS_PREF_KEY,
  moveInOrder,
  normalizeLayout,
  toggleHidden,
  type DashLayout,
  type StripKey,
} from "./layout";

export interface DashLayoutApi {
  layout: DashLayout;
  /** Show or hide one entry of a strip (checkbox checked = visible). */
  toggle: (strip: StripKey, id: string, visible: boolean) => void;
  /** Swap an entry with its neighbour. `registryIds` is the strip's registry, in declaration order. */
  move: (strip: StripKey, registryIds: readonly string[], id: string, dir: -1 | 1) => void;
  setKpisCollapsed: (collapsed: boolean) => void;
}

/**
 * The dashboard's layout, read and persisted. The only place layout state is stored — presets, if they
 * are ever added, would land here and nowhere else.
 *
 * Follows the prefs.ts contract: paint synchronously from the localStorage cache, then reconcile with
 * the server (the source of truth when a writable store is configured), and write through on every
 * change. In snapshot mode `fetchPref`/`savePref` degrade to localStorage with no errors.
 */
export function useDashLayout(): DashLayoutApi {
  const [layout, setLayout] = useState<DashLayout>(() =>
    normalizeLayout(loadPrefLocal<unknown>(LAYOUT_PREF_KEY, null), loadPrefLocal<unknown>(LEGACY_CHARTS_PREF_KEY, null)),
  );

  useEffect(() => {
    // The legacy key is fetched alongside so a user whose pre-layout chart choices only ever reached
    // the server (different browser, cleared cache) still inherits them here.
    void Promise.all([fetchPref<unknown>(LAYOUT_PREF_KEY), fetchPref<unknown>(LEGACY_CHARTS_PREF_KEY)]).then(([stored, legacy]) => {
      if (stored != null || legacy != null) setLayout(normalizeLayout(stored, legacy));
    });
  }, []);

  // Every change rewrites the whole blob — it is one small value, and atomicity is what keeps the
  // strips consistent with each other.
  const update = useCallback((fn: (prev: DashLayout) => DashLayout) => {
    setLayout((prev) => {
      const next = fn(prev);
      if (next === prev) return prev;
      savePref(LAYOUT_PREF_KEY, next);
      return next;
    });
  }, []);

  const toggle = useCallback(
    (strip: StripKey, id: string, visible: boolean) =>
      update((prev) => ({ ...prev, [strip]: { ...prev[strip], hidden: toggleHidden(prev[strip].hidden, id, visible) } })),
    [update],
  );

  const move = useCallback(
    (strip: StripKey, registryIds: readonly string[], id: string, dir: -1 | 1) =>
      update((prev) => {
        const order = moveInOrder(registryIds, prev[strip].order, id, dir);
        // moveInOrder returns the input untouched when the move isn't possible — skip the write.
        return order === prev[strip].order ? prev : { ...prev, [strip]: { ...prev[strip], order } };
      }),
    [update],
  );

  const setKpisCollapsed = useCallback((kpisCollapsed: boolean) => update((prev) => ({ ...prev, kpisCollapsed })), [update]);

  return { layout, toggle, move, setKpisCollapsed };
}
