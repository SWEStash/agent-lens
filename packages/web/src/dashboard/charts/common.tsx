import type { ReactNode } from "react";
import { ResponsiveContainer, AreaChart, BarChart, CartesianGrid, Legend, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import type { DashAudit, DashBreakdowns, DashTime, DashTimeseries } from "../../api";
import { useMeasuredWidth } from "../../useMeasuredWidth";
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
  /** Audit aggregates. Fetched and gated exactly like `time` — null while every tile that reads it
   *  is hidden, and null on its own fetch error without blanking the rest of the dashboard. */
  audit: DashAudit | null;
  expand: Expanded;
  drill: Drilldown;
  /** The dashboard's own date inputs, as local `YYYY-MM-DD` days. Only the burn heatmap reads them:
   *  it normalizes per calendar occurrence of a weekday, and the payload alone cannot show an empty
   *  day at either edge of the requested range. Either end may be blank. */
  range: HeatRange;
}

/**
 * The unit caption for a numeric axis, e.g. `<YAxis label={unitLabel("work tokens", C.muted)} />`.
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

/** Pixels a bucket needs before its bars survive as solid rectangles. Below this recharts emits
 * sub-pixel-wide bars, which antialias into faint slivers — the fill reads as washed out rather than
 * thin, and on a long date range the whole series looks empty. */
const PX_PER_BUCKET = 6;
/** Y axis reservation, subtracted from the measured width to get the plot area. */
export const Y_AXIS_W = 36;

/** Measure the chart body and say whether `count` buckets still fit as bars. Attach the ref to a
 * full-size wrapper around the chart. Before the first observation lands — and in jsdom, which has no
 * ResizeObserver — width is 0 and bars are assumed to fit. */
export function useBarsFit(count: number) {
  const [ref, width] = useMeasuredWidth();
  return [ref, width === 0 || count * PX_PER_BUCKET <= width - Y_AXIS_W] as const;
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

/** A card's two-or-more-way metric switch (the `.seg` button group in its header). */
export function SegToggle<T extends string>({ options, value, onChange }: { options: readonly T[]; value: T; onChange: (v: T) => void }) {
  return (
    <span className="seg" role="group" aria-label="Metric">
      {options.map((o) => (
        <button key={o} type="button" className={value === o ? "on" : ""} onClick={() => onChange(o)}>
          {o}
        </button>
      ))}
    </span>
  );
}

/** The guide paragraph every session-counting chart carries: under a model filter it counts whole
 *  sessions, so its total moves differently from the token charts'. */
export function SessionGrainNote() {
  return (
    <p>
      <strong>Under a model filter this counts whole sessions, not model-attributable rows.</strong> A
      session has no single model, so it is counted here whenever it used any model you ticked — including
      the work it did with the others. That is why a session count and a token total move by different
      amounts when you untick a model.
    </p>
  );
}

/**
 * A bucketed series drawn as bars while the buckets are wide enough to read, and as `dense` (lines or
 * areas) past that, since a line stays 2px wide however many buckets are in range. `bars` and `lines`
 * are the series elements for each form; everything around them is shared.
 */
export function DensityChart({
  data,
  yLabel,
  integer = false,
  dense,
  bars,
  lines,
}: {
  data: object[];
  yLabel: string;
  /** Counts: keep the Y ticks on whole numbers. */
  integer?: boolean;
  dense: "line" | "area";
  bars: ReactNode;
  lines: ReactNode;
}) {
  const { C, axisProps, gridProps, tooltipStyle } = useChartTokens();
  const [ref, asBars] = useBarsFit(data.length);
  const common = (
    <>
      <CartesianGrid {...gridProps} />
      <XAxis dataKey="bucket" {...axisProps} minTickGap={24} />
      <YAxis {...axisProps} width={Y_AXIS_W} allowDecimals={!integer} label={unitLabel(yLabel, C.muted)} />
      <Tooltip {...tooltipStyle} />
      <Legend wrapperStyle={{ fontSize: 12 }} />
    </>
  );
  const Dense = dense === "line" ? LineChart : AreaChart;
  return (
    <div ref={ref} style={{ width: "100%", height: "100%" }}>
      <ResponsiveContainer width="100%" height="100%">
        {asBars ? (
          <BarChart data={data} margin={CHART_MARGIN}>
            {common}
            {bars}
          </BarChart>
        ) : (
          <Dense data={data} margin={CHART_MARGIN}>
            {common}
            {lines}
          </Dense>
        )}
      </ResponsiveContainer>
    </div>
  );
}
