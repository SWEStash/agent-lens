import type { FC } from "react";
import type { ChartProps } from "./charts/common";
import { Activity, CostOverTime, TokensOverTime, ToolErrors } from "./charts/timeseries";
import { Category, Complexity, ErrorTypes, SkillActivation, SubagentFanout, TokensByModel, ToolFrequency } from "./charts/breakdowns";

/**
 * Every dashboard chart, in render order — the single source of truth for both the render loop and the
 * show/hide customizer, so adding a chart is one entry here and nothing else.
 *
 * Ids are stable persisted keys: they appear in the saved `dashboard.layout` (see layout.ts), which
 * stores the HIDDEN ids and an explicit order. NEVER rename an id — a user who hid or moved that chart
 * would silently see it reappear in its default place, and their stored id would linger forever
 * pointing at nothing.
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
