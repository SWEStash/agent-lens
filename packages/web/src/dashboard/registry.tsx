import type { FC } from "react";
import type { ChartProps } from "./charts/common";
import { Activity, CostOverTime, TokensOverTime, ToolErrors } from "./charts/timeseries";
import { Category, Complexity, ErrorTypes, SkillActivation, SubagentFanout, TokensByModel, ToolFrequency } from "./charts/breakdowns";

/**
 * Every dashboard chart, in render order — the single source of truth for both the render loop and the
 * show/hide customizer, so adding a chart is one entry here and nothing else.
 *
 * Ids are stable persisted keys: the pref stores the HIDDEN ids (so a chart added later defaults to
 * visible). NEVER rename an id — a user who hid that chart would silently see it reappear, and their
 * stored id would linger forever pointing at nothing.
 */
export const CHART_REGISTRY: Array<{ id: string; label: string; Component: FC<ChartProps> }> = [
  { id: "tokens-over-time", label: "Tokens over time", Component: TokensOverTime },
  { id: "cost-over-time", label: "Cost over time", Component: CostOverTime },
  { id: "activity", label: "Activity over time", Component: Activity },
  { id: "tool-errors", label: "Tool errors over time", Component: ToolErrors },
  { id: "error-types", label: "Error types", Component: ErrorTypes },
  { id: "tokens-by-model", label: "Tokens by model", Component: TokensByModel },
  { id: "category", label: "Category distribution", Component: Category },
  { id: "complexity", label: "Complexity bands", Component: Complexity },
  { id: "tool-frequency", label: "Tool frequency", Component: ToolFrequency },
  { id: "skill-activation", label: "Skill activation", Component: SkillActivation },
  { id: "subagent-fanout", label: "Subagent fan-out", Component: SubagentFanout },
];

export const CHARTS_PREF_KEY = "dashboard.charts";

/** Gear menu to show/hide chart cards. Mirrors the Sessions column customizer (same `.col-customizer`
 * /`.col-menu` styles, native `<details>` for keyboard/focus). Checkbox checked = visible. */
export function ChartCustomizer({ hidden, onToggle }: { hidden: Set<string>; onToggle: (id: string, visible: boolean) => void }) {
  return (
    <details className="col-customizer">
      <summary aria-label="Show or hide charts" title="Show/hide charts">⚙</summary>
      <div className="col-menu" role="group" aria-label="Toggle charts">
        {CHART_REGISTRY.map((c) => (
          <label key={c.id}>
            <input type="checkbox" checked={!hidden.has(c.id)} onChange={(e) => onToggle(c.id, e.target.checked)} />
            {c.label}
          </label>
        ))}
      </div>
    </details>
  );
}
