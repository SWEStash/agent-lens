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

export interface HeatCell {
  weekday: number;
  hour: number;
  /** Mean work tokens per calendar occurrence of this weekday in range (an unworked day is a zero). */
  mean: number;
  total: number;
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
 * Mean work tokens per local weekday × hour.
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
  rows: readonly BurnHour[],
  zone: string,
  range?: HeatRange,
): { cells: HeatCell[]; max: number } {
  const totals = new Map<string, number>();
  let firstDay: string | null = null;
  let lastDay: string | null = null;
  for (const r of rows) {
    const p = localParts(r.hour, zone);
    if (!p) continue;
    if (firstDay === null || p.dayKey < firstDay) firstDay = p.dayKey;
    if (lastDay === null || p.dayKey > lastDay) lastDay = p.dayKey;
    const k = `${p.weekday}:${p.hour}`;
    totals.set(k, (totals.get(k) ?? 0) + r.work);
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
      cells.push({ weekday, hour, mean, total });
    }
  }
  return { cells, max };
}

/** Which ramp step a value takes, 0 = no spend at all (rendered as bare surface, not as a step). */
export function rampStep(mean: number, max: number, steps: number): number {
  if (mean <= 0 || max <= 0) return 0;
  // sqrt, for the same reason the timeline band uses it: burn is heavily skewed, and a linear scale
  // leaves every hour but the peak in the first step.
  return Math.min(steps, Math.max(1, Math.ceil(Math.sqrt(mean / max) * steps)));
}

/**
 * The value at the top of each ramp step — `rampStep` inverted, so the legend can say what a colour
 * is worth instead of only that it is more than the one before it.
 *
 * It lives beside `rampStep` because the two have to agree: a legend derived independently is a
 * legend that goes quietly wrong the first time the transform changes.
 */
export function rampBounds(max: number, steps: number): number[] {
  if (max <= 0 || steps <= 0) return [];
  return Array.from({ length: steps }, (_, i) => ((i + 1) / steps) ** 2 * max);
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
