/**
 * The timeline band's x-axis: a piecewise-linear scale that compresses idle gaps.
 *
 * A real session is mostly waiting. Measured over 5 174 sessions / 231 797 inter-event gaps, gaps
 * longer than a minute are 2.3% of all gaps but **97.8% of the wall-clock** — so a literal
 * wall-clock axis spends nearly its whole width on almost none of the events. Main (human) sessions
 * run at a median 92% idle and only 6% contain no gap over a minute, which is why compression is the
 * default rather than a rescue mode. Subagent sessions are the opposite (96% have no gap at all), so
 * for them both modes render identically — that is expected, not a bug to special-case.
 *
 * The scale is a list of active `Segment`s separated by fixed-width `Break`s: time is proportional to
 * real duration inside a segment, and a break costs a constant `BREAK_PX` no matter how long it was.
 *
 * Pure — no React, no DOM. `IDLE_GAP_MS` is a constant rather than a user setting because the
 * threshold is not a sensitive parameter: anywhere from 30s to 5min removes 96–98% of the whitespace,
 * and 60s is simply the roundest number on the flat part of that curve.
 */

/** Gaps longer than this collapse to a break marker. See the note above on why it is not tunable. */
export const IDLE_GAP_MS = 60_000;

/** The fixed on-screen cost of one collapsed idle gap. */
export const BREAK_PX = 14;

/** Half-width of the synthetic domain given to a session whose events all share one timestamp, so a
 *  degenerate scale still has a well-defined, monotonic mapping instead of dividing by zero. */
export const DEGENERATE_PAD_MS = 30_000;

/** An event as the scale needs it. Anything without a parseable timestamp is dropped — it cannot be
 *  placed on a time axis — but it stays in the transcript (a filtered-out event would be unreachable). */
export interface ScaleInput {
  uuid: string;
  timestamp: string | null;
}

/** One placed event. `durationMs` is derived (§2.3): there is no stored per-message elapsed time, and
 *  `tool_calls.total_duration_ms` is NULL in 99.5% of rows, so a timestamp delta is the only signal.
 *  It is 0 for the last event of a segment, so a mark never draws across a break. */
export interface TimelinePoint {
  uuid: string;
  t: number;
  durationMs: number;
}

/** A run of events with no gap longer than the threshold. Time is linear inside it. */
export interface Segment {
  t0: number;
  t1: number;
  x0: number;
  x1: number;
}

/** A collapsed idle gap, drawn at a constant width between two segments. */
export interface Break {
  /** Index into `segments` of the segment this break follows. */
  afterSegment: number;
  t0: number;
  t1: number;
  x0: number;
  x1: number;
  durationMs: number;
}

export interface TimeScale {
  points: TimelinePoint[];
  segments: Segment[];
  breaks: Break[];
  width: number;
  /** [first, last] timestamp actually placed, or null when nothing could be placed. */
  domain: [number, number] | null;
  /** Wall-clock from first to last event, breaks included. */
  spanMs: number;
  /** Wall-clock inside segments — the part the axis draws proportionally. */
  activeMs: number;
  /** Wall-clock swallowed by breaks. */
  idleMs: number;
  /** Fewer than two distinct timestamps: there is no real range to brush or zoom over. */
  degenerate: boolean;
  /** Time → pixel. Clamped to the domain. */
  x(t: number): number;
  /** Pixel → time. A pixel inside a break resolves to that break's nearer edge, so dragging across
   *  one still yields a sane, monotonic range. */
  t(x: number): number;
}

export interface ScaleOptions {
  width: number;
  /** Pass `Infinity` for literal wall-clock mode — same machinery, no gap ever exceeds it. */
  gapMs?: number;
  /** Restrict to a time range and re-derive segments over it. This is how zoom works. */
  domain?: [number, number];
  /** Gaps to leave UNCOLLAPSED, keyed by the timestamp of the event that precedes them (stable across
   *  re-renders, unlike an ordinal). Double-clicking a break marker expands just that one in place. */
  expandedGaps?: ReadonlySet<number>;
}

/** Parse to epoch ms, or null when absent/unparseable. */
function parseTime(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Build the scale.
 *
 * Sorts by `timestamp`, never by arrival order: 2 024 events across 408 sessions carry a timestamp
 * earlier than their predecessor's, and drawing those in stored order would run the axis backwards.
 */
export function buildScale(events: readonly ScaleInput[], opts: ScaleOptions): TimeScale {
  const gapMs = opts.gapMs ?? IDLE_GAP_MS;
  const width = Math.max(opts.width, 0);

  const placed = events
    .map((e) => ({ uuid: e.uuid, t: parseTime(e.timestamp) }))
    .filter((e): e is { uuid: string; t: number } => e.t !== null)
    .filter((e) => !opts.domain || (e.t >= opts.domain[0] && e.t <= opts.domain[1]))
    .sort((a, b) => a.t - b.t);

  if (placed.length === 0) return emptyScale(width);

  // Group into active runs, and record the gap that ended each one.
  const runs: Array<{ from: number; to: number }> = [];
  const gaps: number[] = [];
  let start = 0;
  for (let i = 1; i < placed.length; i++) {
    const gap = placed[i].t - placed[i - 1].t;
    if (gap > gapMs && !opts.expandedGaps?.has(placed[i - 1].t)) {
      runs.push({ from: start, to: i - 1 });
      gaps.push(gap);
      start = i;
    }
  }
  runs.push({ from: start, to: placed.length - 1 });

  const first = placed[0].t;
  const last = placed[placed.length - 1].t;
  const degenerate = first === last;

  // A session whose events share one timestamp has no duration to be proportional to. Give it a
  // synthetic +/- window so the mapping stays defined; callers check `degenerate` to suppress the
  // brush, per the band's single-message state.
  const bounds = runs.map(({ from, to }) =>
    degenerate
      ? { t0: placed[from].t - DEGENERATE_PAD_MS, t1: placed[to].t + DEGENERATE_PAD_MS }
      : { t0: placed[from].t, t1: placed[to].t },
  );

  // Width left for real time, after every break has taken its fixed cost.
  const breakWidth = Math.min(gaps.length * BREAK_PX, width);
  const activeWidth = Math.max(width - breakWidth, 0);

  const durations = bounds.map((b) => Math.max(b.t1 - b.t0, 0));
  const totalActive = durations.reduce((a, b) => a + b, 0);
  // Several zero-duration runs (repeated identical timestamps) would otherwise divide by zero; an
  // equal share keeps every run visible and the mapping monotonic.
  const weights = totalActive > 0 ? durations : durations.map(() => 1);
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;

  const segments: Segment[] = [];
  const breaks: Break[] = [];
  let cursor = 0;
  for (let s = 0; s < runs.length; s++) {
    const w = (weights[s] / totalWeight) * activeWidth;
    segments.push({ t0: bounds[s].t0, t1: bounds[s].t1, x0: cursor, x1: cursor + w });
    cursor += w;
    if (s < gaps.length) {
      const bw = Math.min(BREAK_PX, Math.max(width - cursor, 0));
      breaks.push({
        afterSegment: s,
        t0: bounds[s].t1,
        t1: bounds[s + 1].t0,
        x0: cursor,
        x1: cursor + bw,
        durationMs: gaps[s],
      });
      cursor += bw;
    }
  }

  // Derived per-event duration. Zero on the last event of a segment: the gap that follows it is a
  // break, and a mark must not be drawn across one.
  const points: TimelinePoint[] = placed.map((p, i) => {
    const next = placed[i + 1];
    if (!next) return { ...p, durationMs: 0 };
    const gap = next.t - p.t;
    return { ...p, durationMs: gap > gapMs ? 0 : gap };
  });

  const lo = segments[0].t0;
  const hi = segments[segments.length - 1].t1;

  const x = (t: number): number => {
    const c = clamp(t, lo, hi);
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (c <= s.t1 || i === segments.length - 1) {
        if (c < s.t0) return s.x0; // inside the preceding break
        if (s.t1 === s.t0) return (s.x0 + s.x1) / 2;
        return s.x0 + ((c - s.t0) / (s.t1 - s.t0)) * (s.x1 - s.x0);
      }
    }
    return segments[segments.length - 1].x1;
  };

  const t = (px: number): number => {
    const c = clamp(px, 0, cursor);
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (c <= s.x1 || i === segments.length - 1) {
        if (c < s.x0) {
          // Inside the break before this segment: snap to whichever edge is nearer, so a drag over a
          // break resolves to a real boundary rather than to invented time.
          const b = breaks[i - 1];
          return c - b.x0 < b.x1 - c ? b.t0 : b.t1;
        }
        if (s.x1 === s.x0) return s.t0;
        return s.t0 + ((c - s.x0) / (s.x1 - s.x0)) * (s.t1 - s.t0);
      }
    }
    return hi;
  };

  const idleMs = gaps.reduce((a, b) => a + b, 0);
  return {
    points,
    segments,
    breaks,
    width,
    domain: [first, last],
    spanMs: last - first,
    activeMs: Math.max(last - first - idleMs, 0),
    idleMs,
    degenerate,
    x,
    t,
  };
}

function emptyScale(width: number): TimeScale {
  return {
    points: [],
    segments: [],
    breaks: [],
    width,
    domain: null,
    spanMs: 0,
    activeMs: 0,
    idleMs: 0,
    degenerate: true,
    x: () => 0,
    t: () => 0,
  };
}
