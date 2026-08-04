/**
 * Dashboard layout — which KPI tiles and chart cards are shown, in what order, and whether the metrics
 * strip is collapsed. Pure: no React, no storage (that's useDashLayout.ts), so the merge and ordering
 * rules below are unit-testable on their own.
 *
 * Stored as ONE blob under `dashboard.layout` rather than a key per concern: a layout is the unit the
 * user thinks about, and keeping it whole is what would let named presets ("Cost", "Reliability") drop
 * in later as plain values, with no second migration.
 *
 * Visibility is stored as HIDDEN ids — the convention the old `dashboard.charts` pref already used — so
 * a tile or chart added in a later release defaults to VISIBLE rather than silently missing for
 * everyone who saved a layout before it existed.
 */

export const LAYOUT_PREF_KEY = "dashboard.layout";
/** The pre-layout pref: a bare array of hidden chart ids. Read once to seed a first layout. */
export const LEGACY_CHARTS_PREF_KEY = "dashboard.charts";

export type StripKey = "kpis" | "charts";

export interface StripLayout {
  /** Hidden ids. Ids no longer in the registry are kept as-is: harmless, and it preserves the choice
   * across a registry that temporarily drops an entry. `arrange` ignores them either way. */
  hidden: string[];
  /** Explicit order, possibly partial — see `arrangeIds` for how it merges with the registry. */
  order: string[];
}

export interface DashLayout {
  v: 1;
  kpis: StripLayout;
  charts: StripLayout;
  kpisCollapsed: boolean;
}

function emptyStrip(): StripLayout {
  return { hidden: [], order: [] };
}

export function emptyLayout(): DashLayout {
  return { v: 1, kpis: emptyStrip(), charts: emptyStrip(), kpisCollapsed: false };
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function readStrip(v: unknown): StripLayout {
  if (typeof v !== "object" || v === null) return emptyStrip();
  const o = v as Record<string, unknown>;
  return { hidden: stringList(o.hidden), order: stringList(o.order) };
}

/**
 * Parse a stored value into a usable layout, tolerating null, garbage and partial shapes — a pref is
 * user-editable JSON on disk and a malformed one must degrade to defaults, never throw.
 *
 * With no stored layout, `legacyChartsHidden` (the old `dashboard.charts` array) seeds the chart
 * strip so an upgrading user doesn't see every chart they had hidden reappear at once. One-way: the
 * legacy key is never written back.
 */
export function normalizeLayout(raw: unknown, legacyChartsHidden?: unknown): DashLayout {
  if (typeof raw !== "object" || raw === null) {
    const l = emptyLayout();
    l.charts.hidden = stringList(legacyChartsHidden);
    return l;
  }
  const o = raw as Record<string, unknown>;
  return { v: 1, kpis: readStrip(o.kpis), charts: readStrip(o.charts), kpisCollapsed: o.kpisCollapsed === true };
}

/**
 * Merge a stored order with the registry: stored ids first (in stored order, dropping any that no
 * longer exist), then every registry entry the order doesn't mention, in registry order.
 *
 * That trailing clause is the whole point — a chart added in a later release appends at the end of the
 * strip instead of vanishing for every user who ever reordered anything.
 */
export function arrangeIds(registryIds: readonly string[], order: readonly string[]): string[] {
  const known = new Set(registryIds);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of order) {
    if (known.has(id) && !seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  for (const id of registryIds) if (!seen.has(id)) out.push(id);
  return out;
}

/** `arrangeIds` over registry entries. */
export function arrange<T extends { id: string }>(registry: readonly T[], order: readonly string[]): T[] {
  const byId = new Map(registry.map((e) => [e.id, e]));
  return arrangeIds(
    registry.map((e) => e.id),
    order,
  ).map((id) => byId.get(id)!);
}

/**
 * Swap an entry with its neighbour, returning the new **full** order. Materializing every id (rather
 * than editing the stored fragment) keeps the result deterministic: a partial stored order can't make
 * one click jump an item several places. Returns `order` untouched when the move isn't possible, so
 * the caller can skip a pointless write.
 */
export function moveInOrder(registryIds: readonly string[], order: readonly string[], id: string, dir: -1 | 1): string[] {
  const ids = arrangeIds(registryIds, order);
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return order as string[];
  [ids[i], ids[j]] = [ids[j], ids[i]];
  return ids;
}

/** Add or remove an id from a hidden list (checkbox checked = visible). */
export function toggleHidden(hidden: readonly string[], id: string, visible: boolean): string[] {
  const next = hidden.filter((h) => h !== id);
  if (!visible) next.push(id);
  return next;
}
