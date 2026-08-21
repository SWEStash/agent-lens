import { useEffect, useRef, useState } from "react";
import { ResponsiveContainer, AreaChart, Area, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";
import { ChartCard, useChartTokens } from "../../charts/theme";
import { fmtCost, fmtTokens } from "../../format";
import type { ChartProps } from "./common";

/** Stacked token components per bucket. The legend toggles series: hiding the dominant cache-read
 * series lets the others use the full scale, and the stack recomputes automatically. */
export function TokensOverTime({ hidden, ts }: ChartProps) {
  const { TOKEN_COLORS, axisProps, gridProps, tooltipStyle } = useChartTokens();
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setHiddenSeries((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <ChartCard title="Tokens over time" hint="input · output · cache-write · cache-read (kept separate)" hidden={hidden}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={ts?.series ?? []} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="bucket" {...axisProps} minTickGap={24} />
          <YAxis {...axisProps} tickFormatter={(v) => fmtTokens(v as number)} width={48} />
          <Tooltip {...tooltipStyle} formatter={(v: number | string, n: string) => [fmtTokens(Number(v)), n]} />
          <Legend
            wrapperStyle={{ fontSize: 12, cursor: "pointer" }}
            onClick={(o: { dataKey?: unknown }) => o?.dataKey && toggle(String(o.dataKey))}
            formatter={(value: React.ReactNode, entry: { dataKey?: unknown }) => (
              <span style={{ opacity: hiddenSeries.has(String(entry?.dataKey)) ? 0.4 : 1 }}>{value}</span>
            )}
          />
          <Area type="monotone" dataKey="input" hide={hiddenSeries.has("input")} stackId="1" stroke={TOKEN_COLORS.input} fill={TOKEN_COLORS.input} fillOpacity={0.5} />
          <Area type="monotone" dataKey="output" hide={hiddenSeries.has("output")} stackId="1" stroke={TOKEN_COLORS.output} fill={TOKEN_COLORS.output} fillOpacity={0.5} />
          <Area type="monotone" dataKey="cache_creation" hide={hiddenSeries.has("cache_creation")} stackId="1" stroke={TOKEN_COLORS.cache_creation} fill={TOKEN_COLORS.cache_creation} fillOpacity={0.5} />
          <Area type="monotone" dataKey="cache_read" hide={hiddenSeries.has("cache_read")} stackId="1" stroke={TOKEN_COLORS.cache_read} fill={TOKEN_COLORS.cache_read} fillOpacity={0.35} />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function CostOverTime({ hidden, ts }: ChartProps) {
  const { C, axisProps, gridProps, tooltipStyle } = useChartTokens();
  return (
    <ChartCard title="Cost over time" hint="API list price estimate, model × tokens (cache-aware)" hidden={hidden}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={ts?.series ?? []} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="bucket" {...axisProps} minTickGap={24} />
          <YAxis {...axisProps} tickFormatter={(v) => "$" + v} width={48} />
          <Tooltip {...tooltipStyle} formatter={(v: number | string) => fmtCost(Number(v))} />
          <Line type="monotone" dataKey="cost" stroke={C.red} strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/** Pixels a bucket needs before its bars survive as solid rectangles. Below this recharts emits
 * sub-pixel-wide bars, which antialias into faint slivers — the fill reads as washed out rather than
 * thin, and on a long date range the whole series looks empty. */
const PX_PER_BUCKET = 6;
/** Y axis reservation, subtracted from the measured width to get the plot area. */
const Y_AXIS_W = 36;

/** Measure the chart body and say whether `count` buckets still fit as bars. Attach the ref to a
 * full-size wrapper around the chart. Before the first observation lands — and in jsdom, which has no
 * ResizeObserver — width is 0 and bars are assumed to fit. */
function useBarsFit(count: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width === 0 || count * PX_PER_BUCKET <= width - Y_AXIS_W] as const;
}

/** Sessions & turns per bucket. Bars while the buckets are wide enough to read; past that density the
 * same two series switch to lines, which stay 2px wide no matter how many buckets are in range. */
export function Activity({ hidden, ts }: ChartProps) {
  const { C, axisProps, gridProps, tooltipStyle } = useChartTokens();
  const data = ts?.series ?? [];
  const [ref, asBars] = useBarsFit(data.length);
  const common = (
    <>
      <CartesianGrid {...gridProps} />
      <XAxis dataKey="bucket" {...axisProps} minTickGap={24} />
      <YAxis {...axisProps} width={Y_AXIS_W} />
      <Tooltip {...tooltipStyle} />
      <Legend wrapperStyle={{ fontSize: 12 }} />
    </>
  );
  return (
    <ChartCard title="Activity over time" hint="sessions & turns per bucket" hidden={hidden}>
      <div ref={ref} style={{ width: "100%", height: "100%" }}>
        <ResponsiveContainer width="100%" height="100%">
          {asBars ? (
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              {common}
              <Bar dataKey="sessions" fill={C.accent} />
              <Bar dataKey="turns" fill={C.green} />
            </BarChart>
          ) : (
            <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              {common}
              <Line dataKey="sessions" stroke={C.accent} strokeWidth={2} dot={false} />
              <Line dataKey="turns" stroke={C.green} strokeWidth={2} dot={false} />
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}

/** Failures and rejections per bucket, stacked. Same density rule as Activity, with the stack kept
 * intact on the far side: stacked bars become stacked areas, filled opaquely so a one-call bucket
 * still shows up. The bands carry no stroke — an all-zero series (the common case for rejections)
 * would otherwise trace its outline across the top of the series below it. */
export function ToolErrors({ hidden, ts }: ChartProps) {
  const { C, axisProps, gridProps, tooltipStyle } = useChartTokens();
  const data = ts?.series ?? [];
  const [ref, asBars] = useBarsFit(data.length);
  const common = (
    <>
      <CartesianGrid {...gridProps} />
      <XAxis dataKey="bucket" {...axisProps} minTickGap={24} />
      <YAxis {...axisProps} width={Y_AXIS_W} allowDecimals={false} />
      <Tooltip {...tooltipStyle} />
      <Legend wrapperStyle={{ fontSize: 12 }} />
    </>
  );
  return (
    <ChartCard
      title="Tool errors over time"
      hint="failed tool calls per bucket · rejections/blocks kept separate (not agent failures)"
      hidden={hidden}
    >
      <div ref={ref} style={{ width: "100%", height: "100%" }}>
        <ResponsiveContainer width="100%" height="100%">
          {asBars ? (
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              {common}
              <Bar dataKey="failures" name="failures" stackId="e" fill={C.red} />
              <Bar dataKey="rejections" name="rejected/blocked" stackId="e" fill={C.muted} />
            </BarChart>
          ) : (
            <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              {common}
              <Area dataKey="failures" name="failures" stackId="e" stroke="none" fill={C.red} fillOpacity={1} />
              <Area dataKey="rejections" name="rejected/blocked" stackId="e" stroke="none" fill={C.muted} fillOpacity={1} />
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}
