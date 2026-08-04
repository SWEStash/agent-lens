import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchPref, loadPrefLocal, savePref } from "../prefs";
import {
  LAYOUT_PREF_KEY,
  LEGACY_CHARTS_PREF_KEY,
  moveInOrder,
  normalizeLayout,
  resolveActive,
  resolveBody,
  toggleHidden,
  withBody,
  type DashLayout,
  type LayoutBody,
  type StripKey,
} from "./layout";

export interface DashLayoutApi {
  /** The stored layout: which view is active, plus the user's own body if they have one. */
  layout: DashLayout;
  /** The view in effect — `layout.active`, unless it names a preset that no longer exists. */
  active: string;
  /** What to render — the active preset's body, or the user's own. */
  body: LayoutBody;
  /** Switch views. Presets are left pristine; the user's own layout is untouched. */
  setActive: (view: string) => void;
  /** Show or hide one entry of a strip (checkbox checked = visible). */
  toggle: (strip: StripKey, id: string, visible: boolean) => void;
  /** Swap an entry with its neighbour. `registryIds` is the strip's registry, in declaration order. */
  move: (strip: StripKey, registryIds: readonly string[], id: string, dir: -1 | 1) => void;
  /** Restore one strip to registry order with nothing hidden. */
  reset: (strip: StripKey) => void;
  setKpisCollapsed: (collapsed: boolean) => void;
}

/**
 * The dashboard's layout, read and persisted. The only place layout state is stored.
 *
 * Follows the prefs.ts contract: paint synchronously from the localStorage cache, then reconcile with
 * the server (the source of truth when a writable store is configured), and write through on every
 * change. In snapshot mode `fetchPref`/`savePref` degrade to localStorage with no errors.
 *
 * Every mutation goes through `edit`, which applies the change to the RESOLVED body and commits it as
 * the user's own view. That single rule is what makes editing while a preset is active fork instead of
 * overwriting: the preset stays as declared in code, and the fork starts from what was on screen.
 */
export function useDashLayout(kpiIds: readonly string[], chartIds: readonly string[]): DashLayoutApi {
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

  const active = resolveActive(layout);
  const body = useMemo(() => resolveBody(layout, kpiIds, chartIds), [layout, kpiIds, chartIds]);

  // Every change rewrites the whole blob — it is one small value, and atomicity is what keeps the
  // active view and the strips consistent with each other.
  const commit = useCallback((next: DashLayout) => {
    setLayout(next);
    savePref(LAYOUT_PREF_KEY, next);
  }, []);

  /** Apply a change to a copy of what's on screen and commit it as the custom view (the fork). */
  const edit = useCallback(
    (fn: (body: LayoutBody) => LayoutBody | null) => {
      const current = resolveBody(layout, kpiIds, chartIds);
      const next = fn({ kpis: { ...current.kpis }, charts: { ...current.charts } });
      if (next) commit(withBody(layout, next));
    },
    [layout, kpiIds, chartIds, commit],
  );

  const setActive = useCallback((view: string) => commit({ ...layout, active: view }), [layout, commit]);

  const toggle = useCallback(
    (strip: StripKey, id: string, visible: boolean) =>
      edit((b) => ({ ...b, [strip]: { ...b[strip], hidden: toggleHidden(b[strip].hidden, id, visible) } })),
    [edit],
  );

  const move = useCallback(
    (strip: StripKey, registryIds: readonly string[], id: string, dir: -1 | 1) =>
      edit((b) => {
        const order = moveInOrder(registryIds, b[strip].order, id, dir);
        // moveInOrder returns the input untouched when the move isn't possible — skip the write.
        return order === b[strip].order ? null : { ...b, [strip]: { ...b[strip], order } };
      }),
    [edit],
  );

  const reset = useCallback((strip: StripKey) => edit((b) => ({ ...b, [strip]: { hidden: [], order: [] } })), [edit]);

  // Collapse does NOT go through `edit`: it changes how much room the strip takes, not which tiles
  // matter, so it applies to every view and must not fork you off a preset.
  const setKpisCollapsed = useCallback((kpisCollapsed: boolean) => commit({ ...layout, kpisCollapsed }), [layout, commit]);

  return { layout, active, body, setActive, toggle, move, reset, setKpisCollapsed };
}
