import type { ReactNode } from "react";
import { ResponsiveContainer, BarChart, CartesianGrid, XAxis } from "recharts";
import type { DashBreakdowns, DashTime, DashTimeseries } from "../../api";
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
  /** Time analytics. Fetched separately from the other three and skipped entirely when every tile
   *  that reads it is hidden, so it is null more often than `ts`/`bd` — see Dashboard.tsx. */
  time: DashTime | null;
  expand: Expanded;
  drill: Drilldown;
}

/**
 * The unit caption for a numeric axis, e.g. `<YAxis label={unitLabel("work tokens")} />`.
 *
 * Always rendered, never behind a hover: "15.0M" of what is the first question a reader has, and a
 * unit you have to discover by interacting with the chart is a unit most readers never see. Sits
 * horizontally above the axis rather than rotated up its side — rotated axis titles are the classic
 * label nobody reads, and in a three-across grid they cost width the plot needs.
 */
export function unitLabel(value: string, fill: string) {
  // `position: "top"` alone lands the text ABOVE the svg's top edge, where it is clipped and
  // invisible — hence the explicit offset back into the canvas, and CHART_MARGIN's top reservation.
  return { value, position: "insideTopLeft" as const, offset: 0, dy: -14, dx: 2, fill, fontSize: 11 };
}

/** Chart margin with room reserved above the plot for `unitLabel`. */
export const CHART_MARGIN = { top: 22, right: 8, left: 0, bottom: 0 };

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
