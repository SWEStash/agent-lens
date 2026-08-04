/**
 * Curated dashboard views. Plain data — no imports — so it stays trivially testable and so a preset is
 * literally just a value (which is what would let user-created views be added later without reworking
 * anything else).
 *
 * A preset declares the ids it SHOWS, in display order; `hidden` is derived against the live registry
 * when the view is resolved (see resolveBody in layout.ts). That has a deliberate consequence: a chart
 * added in a later release is hidden in a curated view and visible in `all`. A curated view should not
 * silently grow — the counterpart of the append rule that keeps custom layouts intact.
 *
 * Ids must match KPI_REGISTRY / CHART_REGISTRY exactly; a typo is otherwise a silently missing tile,
 * which is what test/presets.test.ts guards.
 *
 * No Security view: the registry has one security tile and no security charts, so it would be a single
 * KPI over an empty grid. The /security page is that surface.
 */

export interface Preset {
  id: string;
  label: string;
  /** Visible KPI ids, in order. Omitted = show every tile in registry order. */
  kpis?: readonly string[];
  /** Visible chart ids, in order. Omitted = show every chart in registry order. */
  charts?: readonly string[];
}

/** The id of the user's own layout — not a preset, but it shares the `active` namespace. */
export const CUSTOM_VIEW = "custom";
/** The default view: everything, registry order. Also the fallback when `active` names nothing. */
export const ALL_VIEW = "all";

export const PRESETS: readonly Preset[] = [
  { id: ALL_VIEW, label: "All" },
  {
    id: "cost",
    label: "Cost",
    kpis: ["cost", "cost-per-session", "total-tokens", "token-breakdown", "cache-read-ratio", "sessions"],
    charts: ["cost-over-time", "tokens-over-time", "tokens-by-model"],
  },
  {
    id: "reliability",
    label: "Reliability",
    kpis: ["tool-error-rate", "rejection-rate", "workflow-runs", "turns", "turn-duration", "session-duration", "security"],
    charts: ["tool-errors", "error-types", "activity"],
  },
  {
    id: "activity",
    label: "Activity",
    kpis: ["sessions", "projects", "turns", "session-duration"],
    charts: ["activity", "category", "complexity", "tool-frequency", "skill-activation", "subagent-fanout"],
  },
];

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
