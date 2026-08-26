/**
 * Fold the server's raw hourly UTC rows into the shapes the time tiles plot.
 *
 * All of it is pure and lives outside the components because it is the part that can be wrong
 * without looking wrong: a mis-bucketed hour produces a perfectly plausible chart. See ADR-033 for
 * why the localization happens here rather than in SQL.
 */
import type { DashTime } from "../api";
import { localParts } from "../tz";

export type BurnHour = DashTime["burn_hours"][number];
export type TurnHour = DashTime["turn_hours"][number];

/** What the heatmap plots. The two are not interchangeable readings of one thing — see `heatCells`. */
export type HeatMetric = "turns" | "tokens";

/** One hour's contribution, whichever metric is selected. */
export interface HeatRow {
  hour: string;
  value: number;
}

/** Rows for the selected metric, in the shape `heatCells` folds. */
export function heatRows(time: DashTime | null, metric: HeatMetric): HeatRow[] {
  if (!time) return [];
  return metric === "tokens"
    ? time.burn_hours.map((r) => ({ hour: r.hour, value: r.work }))
    : time.turn_hours.map((r) => ({ hour: r.hour, value: r.turns }));
}

export interface HeatCell {
  weekday: number;
  hour: number;
  /** Mean of the metric per calendar occurrence of this weekday in range (an unworked day is a zero). */
  mean: number;
  total: number;
  /** Distinct local days on which this cell saw any activity at all. */
  observed: number;
  /** Calendar occurrences of this weekday in range — the denominator behind `mean`. */
  days: number;
}

/** The local calendar range a heatmap normalizes over: the dashboard's own date inputs when both are
 *  set, otherwise the span the payload actually covers. Both ends are local `YYYY-MM-DD` days. */
export interface HeatRange {
  from?: string;
  to?: string;
}

/**
 * How many times each weekday occurs in `[startDay, endDay]` inclusive, index 0 = Sunday.
 *
 * Counted arithmetically rather than by walking the days: a hand-typed `from` of `0001-01-01` would
 * otherwise spin through 700k iterations to answer a question that is `days / 7` plus a remainder.
 * A calendar date's weekday does not depend on a zone, so the UTC midnight of each key is a safe
 * stand-in for it.
 */
function weekdayOccurrences(startDay: string, endDay: string): number[] {
  const start = Date.parse(`${startDay}T00:00:00Z`);
  const end = Date.parse(`${endDay}T00:00:00Z`);
  const counts = new Array(7).fill(0) as number[];
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return counts;
  const days = Math.round((end - start) / 86_400_000) + 1;
  counts.fill(Math.floor(days / 7));
  const firstWeekday = new Date(start).getUTCDay();
  for (let i = 0; i < days % 7; i++) counts[(firstWeekday + i) % 7]++;
  return counts;
}

/**
 * Mean of the selected metric per local weekday × hour.
 *
 * Normalized per *calendar occurrence* of that weekday in range, not per day the weekday was worked:
 * a Sunday nobody touched is a real zero and has to count as one, or the mean answers "how much on a
 * Sunday I worked" while reading as "how much on a Sunday". That distinction overstated Sunday by 74%
 * on the author's own corpus. It also keeps a range ending mid-week from rendering as a quiet Thursday.
 *
 * Days are counted per weekday (not per cell) so a weekday's 24 hours share one denominator and the
 * row sums to that weekday's real daily mean.
 */
export function heatCells(
  rows: readonly HeatRow[],
  zone: string,
  range?: HeatRange,
): { cells: HeatCell[]; max: number } {
  const totals = new Map<string, number>();
  // Distinct days per cell, kept alongside the totals. It is not derivable from `mean` and `total`:
  // both are consistent with one busy day or with fifteen quiet ones, and 17 of the author's active
  // cells rest on a single observed day. The gradient makes a one-off faint; only this makes it legible.
  const observed = new Map<string, Set<string>>();
  let firstDay: string | null = null;
  let lastDay: string | null = null;
  for (const r of rows) {
    const p = localParts(r.hour, zone);
    if (!p) continue;
    if (firstDay === null || p.dayKey < firstDay) firstDay = p.dayKey;
    if (lastDay === null || p.dayKey > lastDay) lastDay = p.dayKey;
    const k = `${p.weekday}:${p.hour}`;
    totals.set(k, (totals.get(k) ?? 0) + r.value);
    // A payload row with a zero value is an hour that produced nothing, not an hour that was worked.
    if (r.value > 0) (observed.get(k) ?? observed.set(k, new Set()).get(k)!).add(p.dayKey);
  }

  // The dashboard's range wins when it is complete, because it knows about the empty days at the
  // edges that the payload cannot show. A half-set or reversed range falls back to the payload's own
  // span rather than dividing everything by zero.
  let occurrences = range?.from && range?.to ? weekdayOccurrences(range.from, range.to) : [];
  if (!occurrences.some((n) => n > 0)) {
    occurrences = firstDay && lastDay ? weekdayOccurrences(firstDay, lastDay) : new Array(7).fill(0);
  }

  const cells: HeatCell[] = [];
  let max = 0;
  for (let weekday = 0; weekday < 7; weekday++) {
    const days = occurrences[weekday];
    for (let hour = 0; hour < 24; hour++) {
      const total = totals.get(`${weekday}:${hour}`) ?? 0;
      const mean = days ? total / days : 0;
      if (mean > max) max = mean;
      cells.push({ weekday, hour, mean, total, observed: observed.get(`${weekday}:${hour}`)?.size ?? 0, days });
    }
  }
  return { cells, max };
}

/**
 * How a value maps onto the colour ramp, 0 = the empty end, 1 = the peak.
 *
 * `linear` for turns, `sqrt` for tokens, and the difference is not cosmetic. Tokens per hour run 276x
 * from the smallest active cell to the peak, so a linear scale leaves everything but the busiest few
 * hours pinned at the bottom. Turns run 3.5x over the median — a well-behaved spread that needs no
 * compression, and compressing it anyway is what put an hour worked once in three months a tenth of
 * the way up the scale (11.8% under sqrt against 1.4% under linear).
 */
export type HeatScale = "linear" | "sqrt";

/** Where a value sits on the ramp, 0..1. Below zero and at zero there is no position — the cell is
 *  empty, which is a reading in its own right and not the bottom of the scale. */
export function rampPosition(mean: number, max: number, scale: HeatScale): number | null {
  if (mean <= 0 || max <= 0) return null;
  const t = Math.min(1, mean / max);
  return scale === "sqrt" ? Math.sqrt(t) : t;
}

/** Mix two `#rrggbb` colours. Straight sRGB: the ramp's own stops sit ~0.065 apart in lightness, so
 *  interpolating between neighbours that close needs no perceptual space to stay smooth. */
function mix(a: string, b: string, t: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const out = [0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t));
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The colour at position `t` along a ramp given as stops — a continuous gradient, not a bin.
 *
 * The stops are the validated `--burn-*` steps, used as gradient anchors rather than as the palette
 * itself. Binning gave every non-zero cell the first step's full colour however small it was, so the
 * empty-to-lowest jump was the largest on the scale (ΔL 0.179 against ~0.065 between neighbours) and
 * a one-off read louder than the step from a busy hour to a busier one. Interpolating means a value
 * 1% of the way up renders 1% of the way up.
 */
export function rampColor(t: number, stops: readonly string[]): string {
  if (stops.length === 0) return "#000000";
  if (stops.length === 1) return stops[0];
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  return mix(stops[i], stops[i + 1], x - i);
}

/**
 * Evenly spaced legend ticks: `[position 0..1, the value that position means]`.
 *
 * Positions are even along the bar and the VALUES are what bend, which is the way round that lets a
 * reader lay a cell's colour against the strip and read a number off it.
 */
export function rampTicks(max: number, scale: HeatScale, n = 5): Array<[number, number]> {
  if (max <= 0) return [];
  return Array.from({ length: n }, (_, i) => {
    const pos = i / (n - 1);
    return [pos, scale === "sqrt" ? pos ** 2 * max : pos * max] as [number, number];
  });
}

export interface BurnPoint {
  /** Local bucket key: `YYYY-MM-DD`, `YYYY-Www` or `YYYY-MM`. Sortable as a string in every case. */
  bucket: string;
  bySource: Record<string, number>;
}

/** The granularity a burn fold uses — the same three the dashboard's bucket control offers. */
export type BurnBucket = "day" | "week" | "month";

/** The local bucket key a day belongs to, at the requested granularity. */
function bucketKey(dayKey: string, bucket: BurnBucket): string {
  if (bucket === "day") return dayKey;
  if (bucket === "month") return dayKey.slice(0, 7);
  return isoWeek(dayKey);
}

/**
 * Work tokens per source, bucketed in LOCAL time at the dashboard's chosen granularity.
 *
 * Sources stay separate all the way through — they have genuinely different profiles and summing
 * them into one line hides the only thing the chart is for.
 *
 * The granularity is the reader's, not ours: a token sum is a fact at any bucket size, so unlike the
 * latency tile (which is pinned to weeks because a daily percentile is often a single observation)
 * this one follows the bucket control. At `day` the two sources' profiles are legible; a week sum
 * flattens them.
 */
export function burnBySource(
  rows: readonly BurnHour[],
  zone: string,
  bucket: BurnBucket,
): { points: BurnPoint[]; sources: string[] } {
  const byBucket = new Map<string, Record<string, number>>();
  const sources = new Set<string>();
  for (const r of rows) {
    const p = localParts(r.hour, zone);
    if (!p) continue;
    const src = r.source ?? "(unassigned)";
    sources.add(src);
    const k = bucketKey(p.dayKey, bucket);
    const acc = byBucket.get(k) ?? {};
    acc[src] = (acc[src] ?? 0) + r.work;
    byBucket.set(k, acc);
  }
  const points = [...byBucket.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, bySource]) => ({ bucket: key, bySource }));
  return { points, sources: [...sources].sort() };
}

/** ISO-8601 week key for a `YYYY-MM-DD` local day. Weeks start Monday and belong to the year holding
 *  their Thursday, so a week spanning New Year is not split into two stubs. */
export function isoWeek(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = (dt.getUTCDay() + 6) % 7; // Monday = 0
  dt.setUTCDate(dt.getUTCDate() - dow + 3); // the Thursday of this week
  const thursday = dt.getTime();
  const jan1 = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = 1 + Math.round((thursday - jan1.getTime()) / 604_800_000 - ((jan1.getUTCDay() + 6) % 7 > 3 ? -1 : 0));
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
