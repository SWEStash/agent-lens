import { useState } from "react";
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

export function Activity({ hidden, ts }: ChartProps) {
  const { C, axisProps, gridProps, tooltipStyle } = useChartTokens();
  return (
    <ChartCard title="Activity over time" hint="sessions & turns per bucket" hidden={hidden}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={ts?.series ?? []} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="bucket" {...axisProps} minTickGap={24} />
          <YAxis {...axisProps} width={36} />
          <Tooltip {...tooltipStyle} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="sessions" fill={C.accent} />
          <Bar dataKey="turns" fill={C.green} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function ToolErrors({ hidden, ts }: ChartProps) {
  const { C, axisProps, gridProps, tooltipStyle } = useChartTokens();
  return (
    <ChartCard
      title="Tool errors over time"
      hint="failed tool calls per bucket · rejections/blocks kept separate (not agent failures)"
      hidden={hidden}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={ts?.series ?? []} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="bucket" {...axisProps} minTickGap={24} />
          <YAxis {...axisProps} width={36} allowDecimals={false} />
          <Tooltip {...tooltipStyle} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="failures" name="failures" stackId="e" fill={C.red} />
          <Bar dataKey="rejections" name="rejected/blocked" stackId="e" fill={C.muted} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
