import { useMemo } from "react";
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";
import { ChartCard, useChartTokens } from "../../charts/theme";
import { fmtDuration, fmtTokens, shortModel } from "../../format";
import { resolveZone, zoneLabel } from "../../tz";
import { heatCells, rampStep, weeklyBySource, rolling7d } from "../burn";
import type { ChartProps } from "./common";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** How many models the latency tile plots. Two lines each, so this is the real series budget. */
const TOP_MODELS = 4;

/** Legend labels wear the text token, never the series colour — the swatch beside them carries the
 *  identity, and coloured text reads as emphasis the data does not mean. */
const mutedLegend = (color: string) => (value: React.ReactNode) => <span style={{ color }}>{value}</span>;

/**
 * Weekday × hour token burn. Recharts has no heatmap, so this is a plain CSS grid of cells —
 * 168 of them, well inside what the DOM handles, and far simpler than bending a scatter into shape.
 *
 * The zone is named in the card: an hour-of-day chart that does not say which clock it is on is a
 * wrong chart, not merely an incomplete one.
 */
export function BurnHeatmap({ hidden, time }: ChartProps) {
  const { BURN_RAMP, C } = useChartTokens();
  const zone = resolveZone();
  const { cells, max } = useMemo(() => heatCells(time?.burn_hours ?? [], zone), [time, zone]);

  return (
    <ChartCard
      title="When tokens are spent"
      hint={`mean work tokens per weekday × hour, ${zoneLabel(zone)} · bucketed by the event's own time, so it will not tie out against "Tokens over time"`}
      hidden={hidden}
    >
      {time && max === 0 ? (
        <div className="empty">No token usage in range.</div>
      ) : (
        <div className="burn">
          <div className="burn-grid" role="img" aria-label={`Token burn by weekday and hour, ${zoneLabel(zone)}`}>
            {WEEKDAYS.map((label, weekday) => (
              <div className="burn-row" key={label}>
                <span className="burn-day">{label}</span>
                {cells
                  .filter((c) => c.weekday === weekday)
                  .map((c) => {
                    const step = rampStep(c.mean, max, BURN_RAMP.length);
                    return (
                      <i
                        key={c.hour}
                        className="burn-cell"
                        style={{ background: step ? BURN_RAMP[step - 1] : C.panel2 }}
                        title={`${label} ${String(c.hour).padStart(2, "0")}:00 — ${fmtTokens(Math.round(c.mean))} work tokens on an average ${label}`}
                      />
                    );
                  })}
              </div>
            ))}
            <div className="burn-row burn-hours">
              <span className="burn-day" />
              {Array.from({ length: 24 }, (_, h) => (
                <i key={h} className="burn-tick">{h % 6 === 0 ? h : ""}</i>
              ))}
            </div>
          </div>
          <div className="burn-legend">
            <span>less</span>
            {BURN_RAMP.map((c, i) => (
              <i key={i} style={{ background: c }} />
            ))}
            <span>more — up to {fmtTokens(Math.round(max))}/h</span>
          </div>
        </div>
      )}
    </ChartCard>
  );
}

/** Weekly work tokens, one line per source. Sources are never summed: they have genuinely different
 *  profiles, and a combined line hides the only thing worth seeing. */
export function WeeklyBurn({ hidden, time }: ChartProps) {
  const { C, PALETTE, axisProps, gridProps, tooltipStyle } = useChartTokens();
  const zone = resolveZone();
  const { weeks, sources } = useMemo(() => weeklyBySource(time?.burn_hours ?? [], zone), [time, zone]);
  const data = weeks.map((w) => ({ week: w.week, ...w.bySource }));

  return (
    <ChartCard title="Weekly burn by source" hint={`work tokens per local ISO week, ${zoneLabel(zone)} · one line per source, never summed`} hidden={hidden}>
      {time && !data.length ? (
        <div className="empty">No token usage in range.</div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="week" {...axisProps} minTickGap={24} />
            <YAxis {...axisProps} tickFormatter={(v) => fmtTokens(v as number)} width={48} />
            <Tooltip {...tooltipStyle} formatter={(v: number | string, n: string) => [fmtTokens(Number(v)), n]} />
            {sources.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} formatter={mutedLegend(C.muted)} />}
            {sources.map((src, i) => (
              <Line key={src} type="monotone" dataKey={src} stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} dot={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

/** Rolling 7-day burn per source. A trailing window needs no reset anchor and no notion of a
 *  provider's billing period, which is exactly why it stands in for a quota burn-up. */
export function Rolling7d({ hidden, time }: ChartProps) {
  const { C, PALETTE, axisProps, gridProps, tooltipStyle } = useChartTokens();
  const zone = resolveZone();
  const { days, sources } = useMemo(() => rolling7d(time?.burn_hours ?? [], zone), [time, zone]);
  const data = days.map((d) => ({ day: d.day, ...d.bySource }));

  return (
    <ChartCard title="Rolling 7-day burn" hint={`trailing 7 local days, ${zoneLabel(zone)} · no provider quota window is assumed`} hidden={hidden}>
      {time && !data.length ? (
        <div className="empty">No token usage in range.</div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="day" {...axisProps} minTickGap={32} />
            <YAxis {...axisProps} tickFormatter={(v) => fmtTokens(v as number)} width={48} />
            <Tooltip {...tooltipStyle} formatter={(v: number | string, n: string) => [fmtTokens(Number(v)), n]} />
            {sources.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} formatter={mutedLegend(C.muted)} />}
            {sources.map((src, i) => (
              <Line key={src} type="monotone" dataKey={src} stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} dot={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

/**
 * Prompt to first assistant token, p50 and p90 per model.
 *
 * The value of this tile is the SHAPE over time, not today's number — a model whose p90 doubles
 * between buckets is the signal, and no single figure can show that. Never a mean: the tail is the
 * story, and a mean hides it behind the median.
 */
export function ModelLatency({ hidden, time }: ChartProps) {
  const { C, PALETTE, axisProps, gridProps, tooltipStyle } = useChartTokens();
  const { data, models, dropped } = useMemo(() => {
    const series = time?.latency.series ?? [];
    // Two lines per model, so the categorical palette runs out fast — and a chart carrying sixteen
    // near-flat lines communicates nothing anyway. Keep the models that actually did the work and
    // say in the hint how many were folded away; a silent cut would read as "these are all of them".
    const volume = new Map<string, number>();
    for (const r of series) volume.set(r.model, (volume.get(r.model) ?? 0) + r.n);
    const ranked = [...volume.entries()].sort((a, b) => b[1] - a[1]);
    const kept = new Set(ranked.slice(0, TOP_MODELS).map(([m]) => m));
    const byBucket = new Map<string, Record<string, number | string>>();
    for (const r of series) {
      if (!kept.has(r.model)) continue;
      const row = byBucket.get(r.bucket) ?? { bucket: r.bucket };
      row[`${r.model} p50`] = r.p50_ms;
      row[`${r.model} p90`] = r.p90_ms;
      byBucket.set(r.bucket, row);
    }
    return {
      data: [...byBucket.values()].sort((a, b) => String(a.bucket).localeCompare(String(b.bucket))),
      models: [...kept].sort(),
      dropped: Math.max(0, ranked.length - TOP_MODELS),
    };
  }, [time]);

  return (
    <ChartCard
      title="Model response latency"
      hint={
        "prompt → first assistant token, p50 solid / p90 dashed · main sessions only, weeks with under 5 turns omitted · " +
        "the p90 tail includes agents parked on a permission prompt, which no query can separate from a slow model" +
        (dropped ? ` · ${dropped} lower-volume model${dropped > 1 ? "s" : ""} not shown` : "")
      }
      hidden={hidden}
    >
      {time && !data.length ? (
        <div className="empty">No turns with a model response in range.</div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="bucket" {...axisProps} minTickGap={24} />
            <YAxis {...axisProps} tickFormatter={(v) => fmtDuration(v as number)} width={52} />
            <Tooltip {...tooltipStyle} formatter={(v: number | string, n: string) => [fmtDuration(Number(v)), n]} />
            <Legend
              wrapperStyle={{ fontSize: 12 }}
              formatter={(value: React.ReactNode) => (
                // Legend text stays in the text token; the swatch beside it carries the identity.
                <span style={{ color: C.muted }}>{shortModel(String(value).replace(/ p\d0$/, "")) + String(value).slice(-4)}</span>
              )}
            />
            {models.map((m, i) => (
              <Line key={m} type="monotone" dataKey={`${m} p50`} stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} dot={false} connectNulls />
            ))}
            {models.map((m, i) => (
              <Line
                key={`${m}-p90`}
                type="monotone"
                dataKey={`${m} p90`}
                stroke={PALETTE[i % PALETTE.length]}
                strokeWidth={2}
                strokeDasharray="4 3"
                dot={false}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

/**
 * How fast the next prompt arrived after a turn ended, split by whether that turn wrote files.
 *
 * An audit metric, not a productivity one. It reports that a reply arrived in four seconds; it does
 * NOT claim that was too fast to have read the diff, and nothing here is coloured or thresholded to
 * imply that it was.
 */
export function ReviewLatency({ hidden, time }: ChartProps) {
  const { C, axisProps, gridProps, tooltipStyle } = useChartTokens();
  const r = time?.review;
  const pct = (part: number, n: number) => (n ? Math.round((part / n) * 1000) / 10 : 0);
  const data = r
    ? [
        { band: "under 10s", wrote: pct(r.wrote.under_10s, r.wrote.n), none: pct(r.none.under_10s, r.none.n) },
        { band: "under 30s", wrote: pct(r.wrote.under_30s, r.wrote.n), none: pct(r.none.under_30s, r.none.n) },
        { band: "under 2min", wrote: pct(r.wrote.under_2min, r.wrote.n), none: pct(r.none.under_2min, r.none.n) },
      ]
    : [];

  return (
    <ChartCard
      title="Turnaround after a turn"
      hint={
        r && r.wrote.n
          ? `share of turns answered within each window · main sessions only · ${r.wrote.n} turns wrote files, ${r.none.n} did not`
          : "share of turns answered within each window · main sessions only"
      }
      hidden={hidden}
    >
      {time && !r?.wrote.n && !r?.none.n ? (
        <div className="empty">No turns with a successor in range.</div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="band" {...axisProps} />
            <YAxis {...axisProps} width={40} tickFormatter={(v) => `${v}%`} />
            <Tooltip {...tooltipStyle} formatter={(v: number | string, n: string) => [`${v}%`, n]} />
            <Legend wrapperStyle={{ fontSize: 12 }} formatter={mutedLegend(C.muted)} />
            <Bar dataKey="wrote" name="turn wrote files" fill={C.accent} radius={[4, 4, 0, 0]} />
            <Bar dataKey="none" name="turn wrote nothing" fill={C.muted} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}
