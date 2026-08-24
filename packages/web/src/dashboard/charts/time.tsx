import { useMemo, useState } from "react";
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";
import { ChartCard, useChartTokens } from "../../charts/theme";
import { fmtDuration, fmtTokens, shortModel } from "../../format";
import { resolveZone, zoneLabel } from "../../tz";
import { burnBySource, heatCells, rampStep, type HeatCell } from "../burn";
import { CHART_MARGIN, decadeDomain, unitLabel, type ChartProps } from "./common";

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
  const [hover, setHover] = useState<{ cell: HeatCell; x: number; y: number } | null>(null);

  return (
    <ChartCard
      title="When tokens are spent"
      hint={`mean work tokens per weekday × hour, ${zoneLabel(zone)}`}
      guide={
        <>
          <p>
            Each cell is one hour of one weekday. Darker means more tokens were spent in that hour on a
            typical day — hover any cell for its exact figure.
          </p>
          <dl>
            <dt>rows / columns</dt>
            <dd>weekday (Sun–Sat) × hour of day, 0–23, in {zoneLabel(zone)} — your own clock.</dd>
            <dt>cell value</dt>
            <dd>
              mean <strong>work tokens</strong> (input + output + cache-write; cache reads excluded)
              per occurrence of that weekday, so a range ending mid-week does not read as a quiet
              Thursday.
            </dd>
          </dl>
          <p>
            Bucketed by each usage event's own timestamp, not its session's start — so its totals
            deliberately <strong>do not match "Tokens over time"</strong>, which buckets by session.
          </p>
          <p>It shows when tokens were spent. It says nothing about whether that was a good time to spend them.</p>
        </>
      }
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
                        onPointerEnter={(e) => {
                          const cell = e.currentTarget.getBoundingClientRect();
                          const box = e.currentTarget.closest(".burn")!.getBoundingClientRect();
                          setHover({ cell: c, x: cell.left - box.left + cell.width / 2, y: cell.top - box.top });
                        }}
                        onPointerLeave={() => setHover(null)}
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
            <span>more — up to {fmtTokens(Math.round(max))} tokens/h</span>
          </div>
          {hover && (
            // Clamped to the card and flipped past the halfway mark so a Saturday-23:00 cell does not
            // push its own tooltip off the edge.
            <div
              className="burn-tip"
              style={{ top: Math.max(0, hover.y - 46), ...(hover.x > 210 ? { right: 0 } : { left: Math.max(0, hover.x - 60) }) }}
              aria-hidden="true"
            >
              <div className="burn-tip-head">
                {WEEKDAYS[hover.cell.weekday]} {String(hover.cell.hour).padStart(2, "0")}:00
              </div>
              <div className="burn-tip-row">
                {fmtTokens(Math.round(hover.cell.mean))} work tokens · average {WEEKDAYS[hover.cell.weekday]}
              </div>
            </div>
          )}
        </div>
      )}
    </ChartCard>
  );
}

/** Work tokens over time, one line per source, at the dashboard's chosen bucket. Sources are never
 *  summed: they have genuinely different profiles, and a combined line hides the only thing worth
 *  seeing. */
export function BurnBySource({ hidden, ts, time }: ChartProps) {
  const { C, PALETTE, axisProps, gridProps, tooltipStyle } = useChartTokens();
  const zone = resolveZone();
  // Follow the bucket the dashboard actually resolved, so this card and "Tokens over time" always
  // agree on granularity. Before `ts` lands there is nothing to follow, so fall back to the bucket
  // this card used when it was pinned to weeks.
  const bucket = ts?.bucket ?? "week";
  const { points, sources } = useMemo(() => burnBySource(time?.burn_hours ?? [], zone, bucket), [time, zone, bucket]);
  const data = points.map((p) => ({ bucket: p.bucket, ...p.bySource }));

  return (
    <ChartCard
      title="Burn by source"
      hint={`work tokens per local ${bucket}, ${zoneLabel(zone)}`}
      guide={
        <>
          <p>How much each account spent over time. Use it to compare the sources, and to spot a bucket that broke the pattern.</p>
          <dl>
            <dt>x-axis</dt>
            <dd>
              local {bucket}, in {zoneLabel(zone)} — it follows the dashboard&apos;s bucket control, so
              switching to <em>day</em> shows each source&apos;s shape where a month would flatten it.
            </dd>
            <dt>y-axis</dt>
            <dd>work tokens — input + output + cache-write, summed over the bucket. Cache reads are excluded.</dd>
            <dt>one line per source</dt>
            <dd>
              Sources are <strong>never added together</strong>: they are separate accounts with
              genuinely different usage profiles, and a combined line would hide the only thing this
              chart is for.
            </dd>
          </dl>
          <p>
            The first and last buckets are usually partial, so their dip is the range boundary, not a
            change in behaviour.
          </p>
          <p>
            These totals <strong>deliberately do not match &quot;Tokens over time&quot;</strong> even at
            the same bucket: this chart places tokens by <em>when they were spent</em>, that one by the
            start of the session that spent them, so a session straddling a boundary lands differently
            in each.
          </p>
        </>
      }
      hidden={hidden}
    >
      {time && !data.length ? (
        <div className="empty">No token usage in range.</div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={CHART_MARGIN}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="bucket" {...axisProps} minTickGap={24} />
            <YAxis {...axisProps} tickFormatter={(v) => fmtTokens(v as number)} width={48} label={unitLabel("work tokens", C.muted)} />
            <Tooltip {...tooltipStyle} formatter={(v: number | string, n: string) => [`${fmtTokens(Number(v))} tokens`, n]} />
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
 * Duration for the latency tile, which is the one place sub-second values have to survive.
 *
 * `fmtDuration` rounds to whole seconds — correct everywhere it is used for session and turn
 * durations, and wrong on a log axis whose bottom decade is milliseconds, where it renders a 100ms
 * gridline as "0s" and a 633ms median as "1s".
 */
function fmtLatency(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : fmtDuration(ms);
}

/**
 * The latency tile's legend, which has two jobs the default one cannot do.
 *
 * It keys by MODEL rather than by line. Recharts would list all eight series, and "opus-5 p50" beside
 * "opus-5 p90" in identical swatches leaves the solid/dashed distinction — the only thing telling the
 * two apart — stated nowhere. So the dash convention is spelled out once, at the end, and each model
 * appears once.
 *
 * The chips toggle. Latency spans decades across models, so one series can own the whole axis; hiding
 * it rescales the plot around what is left. Buttons rather than clickable spans, because this is a
 * control and has to be reachable from the keyboard.
 */
function LatencyLegend({
  models,
  colorFor,
  hiddenModels,
  onToggle,
  muted,
}: {
  models: string[];
  colorFor: (m: string) => string;
  hiddenModels: Set<string>;
  onToggle: (m: string) => void;
  muted: string;
}) {
  const swatch = (color: string, dashed?: boolean) => (
    <svg width="18" height="8" aria-hidden="true" style={{ flex: "none" }}>
      <line x1="0" y1="4" x2="18" y2="4" stroke={color} strokeWidth="2" strokeDasharray={dashed ? "4 3" : undefined} />
    </svg>
  );
  return (
    <div className="lat-legend">
      {models.map((m) => {
        const off = hiddenModels.has(m);
        return (
          <button
            key={m}
            type="button"
            className="lat-chip"
            aria-pressed={!off}
            onClick={() => onToggle(m)}
            title={`${off ? "Show" : "Hide"} ${shortModel(m)}`}
            style={{ opacity: off ? 0.4 : 1 }}
          >
            {swatch(colorFor(m))}
            <span style={{ color: muted }}>{shortModel(m)}</span>
          </button>
        );
      })}
      <span className="lat-key" style={{ color: muted }}>
        {swatch(muted)} p50 {swatch(muted, true)} p90
      </span>
    </div>
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
  const bucket = time?.latency.bucket ?? "week";
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(new Set());
  const toggleModel = (m: string) =>
    setHiddenModels((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });
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

  const colorFor = (m: string) => PALETTE[Math.max(0, models.indexOf(m)) % PALETTE.length];
  const visible = models.filter((m) => !hiddenModels.has(m));

  /**
   * A log axis, with the domain taken from the VISIBLE series only.
   *
   * Latency here spans four orders of magnitude — a median under a second against a p90 of ninety
   * minutes — and on a linear axis the single largest series pins every other line flat against the
   * baseline, which is the state that prompted this. Log is safe rather than merely convenient: the
   * server filters `ms >= 0` and the real corpus bottoms out in the hundreds of milliseconds, so
   * there is no zero for a log scale to fail on. Snapping to whole decades keeps the gridlines at
   * round durations instead of wherever the data happened to land.
   *
   * Recomputing it from the visible series is what makes hiding a model worth doing: drop the series
   * that owns the axis and the rest expand into the space it was using.
   */
  const { domain, ticks } = useMemo(() => {
    const vals: number[] = [];
    for (const row of data) {
      for (const m of visible) {
        for (const p of ["p50", "p90"]) {
          const v = row[`${m} ${p}`];
          if (typeof v === "number") vals.push(v);
        }
      }
    }
    // With every series hidden decadeDomain falls back, so the axis stays plausible rather than
    // collapsing to nothing.
    return decadeDomain(vals);
  }, [data, visible.join("|")]);

  return (
    <ChartCard
      title="Model response latency"
      hint={"prompt → first assistant token, per model" + (dropped ? ` · ${dropped} lower-volume model${dropped > 1 ? "s" : ""} not shown` : "")}
      guide={
        <>
          <p>
            How long a model took to start replying. <strong>Read it for drift between buckets</strong>{" "}
            — a model whose p90 doubles is the signal — not as an absolute number.
          </p>
          <dl>
            <dt>x-axis</dt>
            <dd>
              local {bucket}, following the dashboard&apos;s bucket control. Split by model the turns
              thin out fast, so at a fine bucket <strong>points drop out rather than being drawn</strong>{" "}
              — see the note below.
            </dd>
            <dt>y-axis</dt>
            <dd>
              elapsed time from the prompt to the model&apos;s first response. Solid = median (p50),
              dashed = p90, one colour per model. Never a mean — the tail is the story.{" "}
              <strong>The scale is logarithmic</strong>: each gridline is ten times the one below, so
              equal vertical distances are equal <em>ratios</em>, not equal seconds. A linear axis
              cannot show these together — the slowest tenth runs a hundred times the median, which
              flattens every median onto the baseline.
            </dd>
          </dl>
          <p>
            <strong>The p90 is not pure model latency.</strong> A turn whose reply lands hours later is
            usually an agent parked on a permission prompt waiting for you, and nothing in the data
            separates that from a genuinely slow response. <em>local</em>, if present, is not a model
            at all — it marks replies Claude Code generated without calling one.
          </p>
          <p>
            <strong>Click a model in the legend to hide it</strong>, and the axis rescales around what
            is left — the way to read the fast models when one slow series owns the range.
          </p>
          <p>
            Main sessions only, and only the highest-volume models are plotted. A {bucket} holding
            fewer than <strong>5 turns for a given model is dropped</strong>, because a percentile over
            three observations is not a percentile — so a finer bucket gives a sparser chart, not a
            noisier one. Where a cell holds only a handful of turns its &quot;p90&quot; is close to
            simply its slowest.
          </p>
        </>
      }
      hidden={hidden}
    >
      {time && !data.length ? (
        <div className="empty">No turns with a model response in range.</div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={CHART_MARGIN}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="bucket" {...axisProps} minTickGap={24} />
            <YAxis
              {...axisProps}
              scale="log"
              domain={domain}
              ticks={ticks}
              allowDataOverflow
              tickFormatter={(v) => fmtLatency(v as number)}
              width={52}
              label={unitLabel("time to first token (log)", C.muted)}
            />
            <Tooltip
              {...tooltipStyle}
              formatter={(v: number | string, n: string) => [fmtLatency(Number(v)), shortModel(String(n).replace(/ p\d0$/, "")) + String(n).slice(-4)]}
            />
            <Legend
              wrapperStyle={{ fontSize: 12 }}
              // An ELEMENT, not a `() => <LatencyLegend/>` render function: an inline function is a new
              // component type on every render, so React unmounts and remounts the legend each time a
              // chip is clicked — which throws focus back to the body and leaves a keyboard user
              // unable to press the same chip twice. Passing the element keeps the type stable.
              content={
                <LatencyLegend
                  models={models}
                  colorFor={colorFor}
                  hiddenModels={hiddenModels}
                  onToggle={toggleModel}
                  muted={C.muted}
                />
              }
            />
            {models.map((m) => (
              <Line
                key={m}
                type="monotone"
                dataKey={`${m} p50`}
                hide={hiddenModels.has(m)}
                stroke={colorFor(m)}
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            ))}
            {models.map((m) => (
              <Line
                key={`${m}-p90`}
                type="monotone"
                dataKey={`${m} p90`}
                hide={hiddenModels.has(m)}
                stroke={colorFor(m)}
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
          ? `share of turns answered within each window · ${r.wrote.n} wrote files, ${r.none.n} did not`
          : "share of turns answered within each window"
      }
      guide={
        <>
          <p>
            How quickly the next prompt arrived after a turn finished, split by whether that turn
            changed any files.
          </p>
          <dl>
            <dt>x-axis</dt>
            <dd>how soon the next prompt came — the bands are cumulative, so "under 2min" also counts everything under 30s.</dd>
            <dt>y-axis</dt>
            <dd>percentage of turns in that group. The two groups have different denominators, shown in the subtitle, so compare the shares and not the bar heights as counts.</dd>
          </dl>
          <p>
            This is an <strong>audit</strong> view, not a productivity score. It reports that a reply
            came in four seconds; it makes no claim about whether that was long enough to read the
            diff, and nothing here is coloured or thresholded to suggest one.
          </p>
          <p>Main sessions only — a subagent has no human to turn it around.</p>
        </>
      }
      hidden={hidden}
    >
      {time && !r?.wrote.n && !r?.none.n ? (
        <div className="empty">No turns with a successor in range.</div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={CHART_MARGIN}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="band" {...axisProps} />
            <YAxis {...axisProps} width={40} tickFormatter={(v) => `${v}%`} label={unitLabel("% of turns", C.muted)} />
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
