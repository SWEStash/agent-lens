import type { ReactNode } from "react";
import { ResponsiveContainer, BarChart, CartesianGrid, XAxis } from "recharts";
import type { DashBreakdowns, DashTimeseries } from "../../api";
import { useChartTokens } from "../../charts/theme";
import type { Expanded } from "../useExpanded";
import type { Drilldown } from "../useDrilldown";

/**
 * What every dashboard chart card receives. The payloads are nullable because the three range-filtered
 * fetches land as one unit and a card renders its own empty/zero state until then.
 *
 * `hidden` is passed down rather than filtered out by the parent on purpose: each card renders its own
 * <ChartCard hidden>, so the card COMPONENT stays mounted while hidden and keeps its local view state
 * (the "Tokens by model" metric toggle, the "Tokens over time" legend selection). Filtering the
 * registry instead would unmount them, silently resetting those toggles whenever a chart is hidden
 * and re-shown.
 */
export interface ChartProps {
  hidden: boolean;
  ts: DashTimeseries | null;
  bd: DashBreakdowns | null;
  expand: Expanded;
  drill: Drilldown;
}

/** The scaffolding every ranked horizontal bar card repeats: a full-size vertical-layout BarChart with
 * a numeric X axis and no horizontal grid lines. `yAxis` and the bars/tooltip differ per card, so they
 * stay explicit at the call site. */
export function RankedBars({
  data,
  left = 24,
  top = 4,
  xAxisProps,
  yAxis,
  children,
}: {
  data: readonly unknown[];
  left?: number;
  top?: number;
  /** Extras for the numeric X axis — `allowDecimals`, a `tickFormatter`, … */
  xAxisProps?: Record<string, unknown>;
  yAxis: ReactNode;
  children: ReactNode;
}) {
  const { axisProps, gridProps } = useChartTokens();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data as object[]} layout="vertical" margin={{ top, right: 8, left, bottom: 0 }}>
        <CartesianGrid {...gridProps} horizontal={false} />
        <XAxis type="number" {...axisProps} {...xAxisProps} />
        {yAxis}
        {children}
      </BarChart>
    </ResponsiveContainer>
  );
}
