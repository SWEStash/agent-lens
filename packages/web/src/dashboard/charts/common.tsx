import type { ReactNode } from "react";
import { ResponsiveContainer, BarChart, CartesianGrid, XAxis } from "recharts";
import type { DashBreakdowns, DashTime, DashTimeseries } from "../../api";
import { useChartTokens } from "../../charts/theme";
import type { Expanded } from "../useExpanded";
import type { Drilldown } from "../useDrilldown";
import type { HeatRange } from "../burn";

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
  /** The dashboard's own date inputs, as local `YYYY-MM-DD` days. Only the burn heatmap reads them:
   *  it normalizes per calendar occurrence of a weekday, and the payload alone cannot show an empty
   *  day at either edge of the requested range. Either end may be blank. */
  range: HeatRange;
}

/**
 * The unit caption for a numeric axis, e.g. `<YAxis label={unitLabel("work tokens")} />`.
 *
 * Always rendered, never behind a hover: "15.0M" of what is the first question a reader has, and a
 * unit you have to discover by interacting with the chart is a unit most readers never see. Sits
 * horizontally above the axis rather than rotated up its side — rotated axis titles are the classic
 * label nobody reads, and in a three-across grid they cost width the plot needs.
 *
 * It has to read as a LABEL, not as another tick. Sharing the axis fill and font size put it a few
 * pixels above the topmost tick value in the same muted 11px — "time to first token" directly over
 * "3.3m" ran together as one smudged line. So it is set smaller, uppercase and letter-spaced, which
 * is the conventional treatment for an axis title and is legible as a different KIND of text even
 * before it is read, and it is pushed further from the plot.
 */
export function unitLabel(value: string, fill: string) {
  // "count" is not a unit — it says the numbers are numbers. The caption exists to answer "15.0M of
  // WHAT", and a label that cannot answer it is just clutter above the axis, so it is dropped. The
  // margin above the plot is deliberately kept, so this card's gridlines still line up with the
  // captioned cards beside it in the grid.
  if (value === "count") return undefined;
  // `position: "top"` alone lands the text ABOVE the svg's top edge, where it is clipped and
  // invisible — hence the explicit offset back into the canvas, and CHART_MARGIN's top reservation.
  return {
    value: value.toUpperCase(),
    position: "insideTopLeft" as const,
    offset: 0,
    dy: -19,
    dx: 2,
    fill,
    fontSize: 9.5,
    letterSpacing: 0.7,
    fillOpacity: 0.75,
  };
}

/** Chart margin with room reserved above the plot for `unitLabel` — enough that the caption clears
 *  the topmost tick value rather than sitting on it. */
export const CHART_MARGIN = { top: 30, right: 8, left: 0, bottom: 0 };

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

/**
 * A log-scale domain snapped out to whole decades, with a tick per decade.
 *
 * Used where a series spans orders of magnitude and a linear axis would pin the small values flat
 * against the baseline — latency, where a median under a second sits beside a p90 of ninety minutes.
 * Snapping to decades keeps the gridlines on round values rather than wherever the data happened to
 * land, and callers pass only the VISIBLE values so hiding a series rescales the axis around what is
 * left.
 *
 * Non-positive values are dropped rather than clamped: a log axis has no room for them, and silently
 * moving a zero onto the first decade would misplace it by however many decades that took.
 */
export function decadeDomain(
  values: readonly number[],
  fallback: [number, number] = [1_000, 100_000],
): { domain: [number, number]; ticks: number[] } {
  const pos = values.filter((v) => Number.isFinite(v) && v > 0);
  const [lo, hi] = pos.length
    ? [10 ** Math.floor(Math.log10(Math.min(...pos))), 10 ** Math.ceil(Math.log10(Math.max(...pos)))]
    : fallback;
  // A single decade of data would otherwise produce lo === hi and a zero-height axis.
  const top = Math.max(hi, lo * 10);
  const ticks: number[] = [];
  for (let v = lo; v <= top; v *= 10) ticks.push(v);
  return { domain: [lo, top], ticks };
}
