import type { FC } from "react";
import type { ChartProps } from "./charts/common";
import { Activity, CostOverTime, TokensOverTime, ToolErrors } from "./charts/timeseries";
import { Category, Complexity, ErrorTypes, SkillActivation, SubagentFanout, TokensByModel, ToolFrequency } from "./charts/breakdowns";
import { BurnBySource, BurnHeatmap, ModelLatency, ReviewLatency } from "./charts/time";
import { EditReliability, FileRework, FindingsOverTime, PlanRejections } from "./charts/audit";

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
  // Label follows the card title; the id does NOT change — it is persisted per reader, and renaming
  // it would un-hide the card for anyone who had hidden it.
  { id: "burn-heatmap", label: "When work happens", Component: BurnHeatmap },
  // Id kept as `weekly-burn` though the card no longer pins itself to weeks: ids are persisted per
  // user, and renaming one would un-hide the card for anyone who hid it. The label is what changed.
  { id: "weekly-burn", label: "Burn by source", Component: BurnBySource },
  { id: "model-latency", label: "Model response latency", Component: ModelLatency },
  { id: "review-latency", label: "Turnaround after a turn", Component: ReviewLatency },
  { id: "edit-reliability", label: "Edit failures by model", Component: EditReliability },
  { id: "plan-rejections", label: "Plans & questions sent back", Component: PlanRejections },
  { id: "file-rework", label: "Repeat edits per file", Component: FileRework },
  { id: "findings-over-time", label: "Findings over time", Component: FindingsOverTime },
];

/** The chart ids backed by `/api/dashboard/time`. Dashboard.tsx skips that fetch entirely while all
 *  of them are hidden, so a reader who does not use these tiles never pays for them. */
export const TIME_CHART_IDS = ["burn-heatmap", "weekly-burn", "model-latency", "review-latency"];

/** The chart ids backed by `/api/dashboard/audit`, gated the same way. */
export const AUDIT_CHART_IDS = ["edit-reliability", "plan-rejections", "file-rework", "findings-over-time"];
