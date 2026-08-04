/**
 * Dashboard layout — which view is active, and, for the user's own view, which KPI tiles and chart
 * cards are shown, in what order, and whether the metrics strip is collapsed. Pure: no React, no
 * storage (that's useDashLayout.ts), so the resolution and ordering rules below are unit-testable on
 * their own.
 *
 * Stored as ONE blob under `dashboard.layout` rather than a key per concern: a layout is the unit the
 * user thinks about, and keeping it whole is what lets a view switch be a single atomic write.
 *
 * Two ideas carry the whole design:
 *
 * 1. Visibility is stored as HIDDEN ids — the convention the old `dashboard.charts` pref used — so a
 *    tile or chart added in a later release defaults to VISIBLE in the user's own layout rather than
 *    silently missing for everyone who saved one before it existed.
 * 2. A preset never overwrites the user's layout: editing while a preset is active FORKS (see
 *    `withBody`), so `custom` is only ever replaced by the user's own edits.
 */
import { ALL_VIEW, CUSTOM_VIEW, findPreset, type Preset } from "./presets";

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

/** A resolved selection: what the page actually renders, whether it came from a preset or from
 * `custom`. Selection only — see `kpisCollapsed` on DashLayout for why collapse isn't in here. */
export interface LayoutBody {
  kpis: StripLayout;
  charts: StripLayout;
}

export interface DashLayout {
  v: 1;
  /** A preset id, or CUSTOM_VIEW. */
  active: string;
  /** The user's own layout. Null until the first fork — which is what keeps the "Custom" pill from
   * existing before it means anything, and makes a fresh install open on `all` with no extra logic. */
  custom: LayoutBody | null;
  /** Whether the metrics strip is collapsed. Deliberately OUTSIDE the body: collapsing changes how much
   * room the strip takes, not which tiles matter, so it applies across every view and — unlike a
   * hide or a reorder — must not fork you off a preset. */
  kpisCollapsed: boolean;
}

function emptyStrip(): StripLayout {
  return { hidden: [], order: [] };
}

/** Everything visible, registry order — the `all` view, and the starting point for a fresh install. */
export function emptyBody(): LayoutBody {
  return { kpis: emptyStrip(), charts: emptyStrip() };
}

export function emptyLayout(): DashLayout {
  return { v: 1, active: ALL_VIEW, custom: null, kpisCollapsed: false };
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function readStrip(v: unknown): StripLayout {
  if (typeof v !== "object" || v === null) return emptyStrip();
  const o = v as Record<string, unknown>;
  return { hidden: stringList(o.hidden), order: stringList(o.order) };
}

function readBody(v: unknown): LayoutBody | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  return { kpis: readStrip(o.kpis), charts: readStrip(o.charts) };
}

/**
 * Parse a stored value into a usable layout, tolerating null, garbage and partial shapes — a pref is
 * user-editable JSON on disk and a malformed one must degrade to defaults, never throw.
 *
 * With no stored layout, `legacyChartsHidden` (the old `dashboard.charts` array) seeds a custom view
 * so an upgrading user doesn't see every chart they had hidden reappear at once. That lands them on
 * `custom` rather than `all` precisely because hiding those charts WAS a customization. One-way: the
 * legacy key is never written back.
 */
export function normalizeLayout(raw: unknown, legacyChartsHidden?: unknown): DashLayout {
  if (typeof raw !== "object" || raw === null) {
    const legacy = stringList(legacyChartsHidden);
    if (legacy.length === 0) return emptyLayout();
    const custom = emptyBody();
    custom.charts.hidden = legacy;
    return { v: 1, active: CUSTOM_VIEW, custom, kpisCollapsed: false };
  }
  const o = raw as Record<string, unknown>;
  return {
    v: 1,
    active: typeof o.active === "string" ? o.active : ALL_VIEW,
    custom: readBody(o.custom),
    kpisCollapsed: o.kpisCollapsed === true,
  };
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

/** One strip of a preset: the declared ids become the order, everything else in the registry is hidden.
 * An undeclared strip means "show everything", which is how the `all` view is expressed. */
function presetStrip(visible: readonly string[] | undefined, registryIds: readonly string[]): StripLayout {
  if (!visible) return emptyStrip();
  const shown = new Set(visible);
  return { order: [...visible], hidden: registryIds.filter((id) => !shown.has(id)) };
}

export function presetBody(preset: Preset, kpiIds: readonly string[], chartIds: readonly string[]): LayoutBody {
  return { kpis: presetStrip(preset.kpis, kpiIds), charts: presetStrip(preset.charts, chartIds) };
}

/**
 * The view actually in effect. An `active` naming a preset that no longer exists (renamed or dropped in
 * a later release) falls back to the user's own layout, or to `all` — presets are code, so nobody gets
 * stranded on a dead id.
 *
 * Both the rendered body and the switcher's selected button must go through this, or a dead id shows
 * one view's content with no button highlighted. The stored value is left alone rather than rewritten,
 * so a preset that comes back is honoured again.
 */
export function resolveActive(layout: DashLayout): string {
  if (layout.active !== CUSTOM_VIEW && findPreset(layout.active)) return layout.active;
  return layout.custom ? CUSTOM_VIEW : ALL_VIEW;
}

/** What the page should render, for whichever view `resolveActive` says is in effect. */
export function resolveBody(layout: DashLayout, kpiIds: readonly string[], chartIds: readonly string[]): LayoutBody {
  const active = resolveActive(layout);
  if (active !== CUSTOM_VIEW) return presetBody(findPreset(active)!, kpiIds, chartIds);
  return layout.custom ?? emptyBody();
}

/**
 * Commit an edited body as the user's own layout and switch to it. This is the fork: callers pass the
 * body they just mutated — which is the RESOLVED one, so editing while "Cost" is active starts from
 * Cost's selection rather than from a default layout, and the preset itself is left pristine.
 */
export function withBody(layout: DashLayout, custom: LayoutBody): DashLayout {
  return { ...layout, active: CUSTOM_VIEW, custom };
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
