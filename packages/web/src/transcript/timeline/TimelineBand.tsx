/**
 * The session timeline band: a minimap of where the work, the waiting, and the audit-relevant events
 * are. Bespoke SVG rather than Recharts — the marks are a custom geometry (derived-duration spans over
 * a piecewise scale, with an annotation rail) that no chart library models, and the largest session in
 * the corpus is 1 632 events, well inside what SVG handles.
 *
 * Rendering only. Selection, zoom and click-to-jump arrive with the interaction layer; the props are
 * shaped for them but this component draws a static band.
 */
import { useEffect, useRef, useState } from "react";
import type { EventNode, Finding, FileChangeRow } from "../../api";
import { fmtDuration } from "../../format";
import { useChartTokens } from "../../charts/theme";
import { buildScale, type TimeScale } from "./scale";
import { buildMarks, hasUsage, type Mark, type MarkKind, type TokenMetric } from "./marks";
import type { AxisMode } from "../viewPrefs";

/** Band geometry. The plot is the token bars; the rail below carries the audit annotations. */
const PLOT_H = 44;
const RAIL_H = 6;
const RAIL_GAP = 3;
const SVG_H = PLOT_H + RAIL_GAP + RAIL_H;
/** A span narrower than this still has to be visible, so it degenerates into a tick on its own. */
const MIN_MARK_W = 2;
/** User and meta events never render as spans — a user message does not "last". */
const TICK_W = 3;
/** Shortest bar that still reads as a bar, so a small-but-nonzero message isn't invisible. */
const MIN_BAR_H = 3;

/** Measure the band's width so the scale can be built in real pixels. Before the first observation
 *  lands — and in jsdom, which has no ResizeObserver — width is 0 and the band renders its caption
 *  only, which is also the correct pre-layout state. */
function useMeasuredWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

const LEGEND: Array<{ kind: MarkKind; label: string }> = [
  { kind: "user", label: "user" },
  { kind: "assistant", label: "assistant" },
  { kind: "thinking", label: "thinking" },
  { kind: "tool", label: "tool" },
];

/**
 * Word a break by what BOUNDS it, and nothing more.
 *
 * We can derive who held the ball; we cannot derive why. 77% of idle time sits before a human prompt —
 * AFK, reading the output, thinking, or deliberately spending quota later, and those are
 * indistinguishable in the data. 23% falls mid-turn, where a long tool call and an agent parked on a
 * permission prompt are equally indistinguishable (`total_duration_ms` is NULL in 99.5% of rows). So
 * the label states the bound and stops.
 */
function breakLabel(ms: number, nextIsHumanPrompt: boolean): string {
  return nextIsHumanPrompt
    ? `${fmtDuration(ms)} before your next message`
    : `${fmtDuration(ms)} mid-turn`;
}

export interface TimelineBandProps {
  events: readonly EventNode[];
  findings?: readonly Finding[] | null;
  fileChanges?: readonly FileChangeRow[] | null;
  /** `turns[].user_event_uuid` — the events that are REAL human prompts. Tool results arrive with
   *  role "user" too, so the role alone cannot tell them apart, and the break wording depends on it. */
  userPromptUuids?: ReadonlySet<string>;
  axisMode: AxisMode;
  onAxisMode: (m: AxisMode) => void;
  metric: TokenMetric;
  onMetric: (m: TokenMetric) => void;
}

export function TimelineBand(props: TimelineBandProps) {
  const { events, findings, fileChanges, userPromptUuids, axisMode, onAxisMode, metric, onMetric } = props;
  const [ref, width] = useMeasuredWidth();
  const { TIMELINE_COLORS, C } = useChartTokens();

  const usagePresent = hasUsage(events);
  // With no usage anywhere the metric is meaningless: heights go uniform and the toggle disappears,
  // rather than the band drawing a flat row of zero-height marks.
  const effectiveMetric: TokenMetric = usagePresent ? metric : "work";

  const scale = buildScale(events, {
    width,
    gapMs: axisMode === "literal" ? Infinity : undefined,
  });
  const marks = buildMarks({ events, points: scale.points, findings, fileChanges, metric: effectiveMetric });

  if (events.length === 0) return null;
  if (!scale.domain) {
    return (
      <div className="timeline" ref={ref}>
        <div className="tl-caption muted">No timing data for this session.</div>
      </div>
    );
  }

  const caption = [
    `${scale.points.length} message${scale.points.length === 1 ? "" : "s"}`,
    scale.spanMs > 0 ? `${fmtDuration(scale.spanMs)} span` : null,
    scale.breaks.length ? `${scale.breaks.length} break${scale.breaks.length === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // sqrt, not log: it handles the zeros log cannot, and still keeps one huge message from flattening
  // everything else.
  //
  // sqrt alone is not enough, though. Real sessions run ~40x from the median message to the largest,
  // which under max-normalisation puts the MEDIAN bar at 16% of the band — a flat line with two
  // spikes, which is the outcome sqrt was chosen to avoid. So the reference is the 95th percentile
  // and the top few marks clamp to full height. The exact number stays available on the mark itself,
  // so nothing is hidden: what is given up is only "how much taller" the tallest few are.
  const graded = marks.map((k) => k.value).filter((v) => v > 0).sort((a, b) => a - b);
  const reference = graded.length ? graded[Math.min(Math.floor(graded.length * 0.95), graded.length - 1)] : 0;
  const barHeight = (v: number): number => {
    if (!usagePresent || reference <= 0) return PLOT_H * 0.6; // uniform fallback
    if (v <= 0) return MIN_BAR_H;
    return Math.max(MIN_BAR_H, Math.min(1, Math.sqrt(v) / Math.sqrt(reference)) * PLOT_H);
  };

  const present = new Set<MarkKind>(marks.map((m) => m.kind));

  const fillFor = (k: MarkKind): string =>
    k === "tool-error" ? TIMELINE_COLORS.toolError : k === "meta" ? C.muted : TIMELINE_COLORS[k];

  return (
    <div className="timeline" ref={ref}>
      <div className="tl-head">
        {usagePresent && (
          <label className="tl-ctl">
            <span className="sr-only">Mark height metric</span>
            <select value={metric} onChange={(e) => onMetric(e.target.value as TokenMetric)}>
              <option value="work">work tokens</option>
              <option value="output">output tokens</option>
              <option value="total">total (incl. cache read)</option>
            </select>
          </label>
        )}
        {/* Hidden when the session has no breaks: the two axes are then byte-identical, which is the
            normal case for a subagent (96% contain no gap over a minute at all). */}
        {scale.breaks.length > 0 && (
          <button
            type="button"
            className="link-btn tl-axis"
            onClick={() => onAxisMode(axisMode === "compressed" ? "literal" : "compressed")}
            title={
              axisMode === "compressed"
                ? "Idle gaps are collapsed. Switch to literal wall-clock."
                : "Literal wall-clock. Switch to collapsed idle gaps."
            }
          >
            time ⇄ {axisMode}
          </button>
        )}
        <span className="tl-caption muted">{caption}</span>
      </div>

      {width > 0 && (
        <svg
          className="tl-svg"
          width={width}
          height={SVG_H}
          role="group"
          aria-label={`Session timeline: ${caption}`}
        >
          {/* Breaks first, so marks paint over their edges rather than under them. */}
          {scale.breaks.map((b, i) => {
            // The event the break lands on decides the wording.
            const next = scale.points.find((p) => p.t >= b.t1);
            const nextIsPrompt = !!next && !!userPromptUuids?.has(next.uuid);
            return (
              <g key={"b" + i} className="tl-break">
                <rect x={b.x0} y={0} width={b.x1 - b.x0} height={PLOT_H} />
                <title>{breakLabel(b.durationMs, nextIsPrompt)}</title>
              </g>
            );
          })}
          {marks.map((m) => (
            <MarkRect key={m.uuid} m={m} scale={scale} h={barHeight(m.value)} fill={fillFor(m.kind)} />
          ))}
          {/* Annotation rail: the audit-relevant events, below the baseline. */}
          <g className="tl-rail" transform={`translate(0, ${PLOT_H + RAIL_GAP})`}>
            {marks.map((m) => {
              const x = scale.x(m.t);
              return (
                <g key={"r" + m.uuid}>
                  {m.error && <rect className="tl-err" x={x} y={0} width={2} height={RAIL_H} />}
                  {m.finding && <rect className={"tl-find sev-" + m.finding} x={x} y={0} width={2} height={RAIL_H} />}
                  {m.fileChange && <rect className="tl-file" x={x} y={1} width={3} height={3} />}
                  {m.spawn && <path className="tl-spawn" d={`M ${x - 2} 0 L ${x + 2} 0 L ${x} 4 Z`} />}
                </g>
              );
            })}
          </g>
        </svg>
      )}

      {/* Only the types actually in this session. A fixed legend would advertise categories that
          cannot occur — "thinking" never fires on a Claude Code transcript, because thinking blocks
          arrive with their text stripped (an empty string plus a signature), so no event ever carries
          thinking text to colour. */}
      <div className="tl-legend">
        {LEGEND.filter((l) => present.has(l.kind)).map((l) => (
          <span key={l.kind} className="tl-key">
            <span className="tl-swatch" style={{ background: fillFor(l.kind) }} />
            {l.label}
          </span>
        ))}
        {present.has("tool-error") && (
          <span className="tl-key">
            <span className="tl-swatch" style={{ background: TIMELINE_COLORS.toolError }} />
            tool error
          </span>
        )}
      </div>
    </div>
  );
}

/** One event. A span for anything that genuinely occupies time; a fixed tick for user and meta events,
 *  because a user message does not "last" — the gap after it is the human being away. */
function MarkRect({ m, scale, h, fill }: { m: Mark; scale: TimeScale; h: number; fill: string }) {
  const x = scale.x(m.t);
  const isTick = m.kind === "user" || m.kind === "meta";
  const w = isTick ? TICK_W : Math.max(MIN_MARK_W, scale.x(m.t + m.durationMs) - x - 1);
  return (
    <rect className="tl-mark" x={x} y={PLOT_H - h} width={w} height={h} rx={2} fill={fill} />
  );
}
