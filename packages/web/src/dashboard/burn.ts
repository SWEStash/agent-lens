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
  /** Mean work tokens per day on which this weekday was observed at all. */
  mean: number;
  total: number;
}

/**
 * Mean work tokens per local weekday × hour.
 *
 * Normalized per *occurrence of that weekday* rather than by raw total: a range that ends mid-week
 * has fewer Thursdays than Mondays in it, and raw totals would render that as a quiet Thursday.
 * Days are counted per weekday (not per cell) so a weekday's 24 hours share one denominator and the
 * row sums to that weekday's real daily mean.
 */
export function heatCells(rows: readonly BurnHour[], zone: string): { cells: HeatCell[]; max: number } {
  const totals = new Map<string, number>();
  const daysPerWeekday: Array<Set<string>> = Array.from({ length: 7 }, () => new Set());
  for (const r of rows) {
    const p = localParts(r.hour, zone);
    if (!p) continue;
    daysPerWeekday[p.weekday].add(p.dayKey);
    const k = `${p.weekday}:${p.hour}`;
    totals.set(k, (totals.get(k) ?? 0) + r.work);
  }
  const cells: HeatCell[] = [];
  let max = 0;
  for (let weekday = 0; weekday < 7; weekday++) {
    const days = daysPerWeekday[weekday].size;
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

export interface WeekPoint {
  /** Local ISO-ish week key, `YYYY-Www`, sortable as a string. */
  week: string;
  bySource: Record<string, number>;
}

/**
 * Weekly work tokens per source, in LOCAL weeks, plus a rolling 7-day total per source.
 *
 * Sources stay separate all the way through — they have genuinely different profiles and summing
 * them into one line hides the only thing the chart is for.
 */
export function weeklyBySource(rows: readonly BurnHour[], zone: string): { weeks: WeekPoint[]; sources: string[] } {
  const byWeek = new Map<string, Record<string, number>>();
  const sources = new Set<string>();
  for (const r of rows) {
    const p = localParts(r.hour, zone);
    if (!p) continue;
    const src = r.source ?? "(unassigned)";
    sources.add(src);
    const wk = isoWeek(p.dayKey);
    const bucket = byWeek.get(wk) ?? {};
    bucket[src] = (bucket[src] ?? 0) + r.work;
    byWeek.set(wk, bucket);
  }
  const weeks = [...byWeek.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, bySource]) => ({ week, bySource }));
  return { weeks, sources: [...sources].sort() };
}

export interface DayPoint {
  day: string;
  bySource: Record<string, number>;
}

/**
 * Rolling 7-day work tokens per source, by local day.
 *
 * A rolling window needs no reset anchor and no notion of a provider's billing period, which is
 * exactly why it replaced the reconstructed 5-hour quota window (see the design doc, §14.3).
 * Days with no activity still get a point, or the window would silently skip over idle stretches.
 */
export function rolling7d(rows: readonly BurnHour[], zone: string): { days: DayPoint[]; sources: string[] } {
  const perDay = new Map<string, Record<string, number>>();
  const sources = new Set<string>();
  for (const r of rows) {
    const p = localParts(r.hour, zone);
    if (!p) continue;
    const src = r.source ?? "(unassigned)";
    sources.add(src);
    const bucket = perDay.get(p.dayKey) ?? {};
    bucket[src] = (bucket[src] ?? 0) + r.work;
    perDay.set(p.dayKey, bucket);
  }
  const keys = [...perDay.keys()].sort();
  if (!keys.length) return { days: [], sources: [] };
  const all = eachDay(keys[0], keys[keys.length - 1]);
  const srcList = [...sources].sort();
  const days: DayPoint[] = [];
  for (let i = 0; i < all.length; i++) {
    const bySource: Record<string, number> = {};
    for (const src of srcList) {
      let sum = 0;
      for (let k = Math.max(0, i - 6); k <= i; k++) sum += perDay.get(all[k])?.[src] ?? 0;
      bySource[src] = sum;
    }
    days.push({ day: all[i], bySource });
  }
  return { days, sources: srcList };
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

/** Every `YYYY-MM-DD` from `from` to `to` inclusive. */
function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(to + "T00:00:00Z");
  for (let t = Date.parse(from + "T00:00:00Z"); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
