/**
 * The session timeline band: a minimap of where the work, the waiting, and the audit-relevant events
 * are. Bespoke SVG rather than Recharts — the marks are a custom geometry (derived-duration spans over
 * a piecewise scale, with an annotation rail) that no chart library models, and the largest session in
 * the corpus is 1 632 events, well inside what SVG handles.
 *
 * The band owns its own interaction: pointer drag sets the selection range, a click under the drag
 * threshold jumps to that message, double-clicking a break marker opens that idle gap to scale, and
 * the whole band is a single tab stop with a roving cursor announced through an aria-live region.
 * Filtering the transcript from the selection is the caller's job — see SessionView.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { EventNode, Finding, FileChangeRow } from "../../api";
import { fmtDuration, fmtTokens } from "../../format";
import { useChartTokens } from "../../charts/theme";
import { buildScale, type TimeScale } from "./scale";
import { barHeight, buildMarks, contextLine, hasUsage, heightReference, type Mark, type MarkKind, type TokenMetric } from "./marks";
import { useBandBrush, type NearMark } from "./useBandBrush";
import { useBandCursor } from "./useBandCursor";
import type { AxisMode } from "../viewPrefs";
import { toggleIn } from "../../sets";
import { useMeasuredWidth } from "../../useMeasuredWidth";
import { isTypingTarget } from "../searchKeys";

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

/** A mark kind as words, for the tooltip and the screen-reader announcement. */
const kindLabel = (kind: string) => (kind === "tool-error" ? "tool error" : kind);

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
  /** turn id -> 0-based seq, so a hovered mark can say which turn it belongs to. */
  turnSeqById?: ReadonlyMap<string, number> | null;
  /** `turns[].user_event_uuid` — the events that are REAL human prompts. Tool results arrive with
   *  role "user" too, so the role alone cannot tell them apart, and the break wording depends on it. */
  userPromptUuids?: ReadonlySet<string>;
  axisMode: AxisMode;
  onAxisMode: (m: AxisMode) => void;
  metric: TokenMetric;
  onMetric: (m: TokenMetric) => void;
  /** The datetime range filtering the transcript, or null. Lives in the URL, owned by SessionView. */
  range: [number, number] | null;
  onRange: (r: [number, number] | null) => void;
  /** Jump the transcript to a message (expand its turn, scroll, flash). */
  onJump: (uuid: string) => void;
  /** What the axis currently SHOWS. Distinct from `range`, which is what the transcript FILTERS to —
   *  conflating the two is the usual mistake here. */
  domain: [number, number] | null;
}

/** Where a mark sits and how wide it is. A span for anything that genuinely occupies time; a fixed
 *  tick for user and meta events, because a user message does not "last" — the gap after it is the
 *  human being away. */
function markGeom(m: Mark, scale: TimeScale): { x: number; w: number } {
  const x = scale.x(m.t);
  const isTick = m.kind === "user" || m.kind === "meta";
  return { x, w: isTick ? TICK_W : Math.max(MIN_MARK_W, scale.x(m.t + m.durationMs) - x - 1) };
}

export function TimelineBand(props: TimelineBandProps) {
  const { events, findings, fileChanges, userPromptUuids, turnSeqById, axisMode, onAxisMode, metric, onMetric } = props;
  const { range, onRange, onJump, domain } = props;
  // Width 0 (pre-layout, or jsdom) renders the caption only, which is the correct pre-layout state.
  const [ref, width] = useMeasuredWidth();
  const svgRef = useRef<SVGSVGElement>(null);
  // Idle gaps the reader has opened in place, keyed by the timestamp before them.
  const [expandedGaps, setExpandedGaps] = useState<ReadonlySet<number>>(() => new Set());
  // The mark under the pointer. Without it, clicking or brushing is a guess: the marks are only a few
  // pixels wide, and colour plus height say nothing about which message they are.
  const [hover, setHover] = useState<{ uuid: string; x: number; w: number } | null>(null);
  const { TIMELINE_COLORS, C } = useChartTokens();

  const usagePresent = hasUsage(events);

  // Esc clears the selection and leaves the domain alone — they are separate concepts (see props).
  useEffect(() => {
    if (!range) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (isTypingTarget(e.target)) return;
      onRange(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [range, onRange]);
  // With no usage anywhere the metric is meaningless: heights go uniform and the toggle disappears,
  // rather than the band drawing a flat row of zero-height marks.
  const effectiveMetric: TokenMetric = usagePresent ? metric : "work";

  // Memoized: hover, the keyboard cursor and every pointer move of a drag re-render the band, and
  // none of them changes the scale or the marks — rebuilding both meant re-sorting every message.
  const scale = useMemo(
    () => buildScale(events, { width, gapMs: axisMode === "literal" ? Infinity : undefined, ...(domain ? { domain } : {}), expandedGaps }),
    [events, width, axisMode, domain, expandedGaps],
  );
  const marks = useMemo(
    () => buildMarks({ events, points: scale.points, findings, fileChanges, turnSeqById, metric: effectiveMetric }),
    [events, scale.points, findings, fileChanges, turnSeqById, effectiveMetric],
  );

  /** Distance from `px` to a mark, measured to its whole SPAN rather than its start: a long assistant
   *  or tool message can be tens of pixels wide, and measuring from its leading edge left most of the
   *  bar unhoverable and unclickable. Zero when the pointer is on the mark. */
  const nearestMark = (px: number): NearMark | null => {
    let best: NearMark | null = null;
    for (const m of marks) {
      const { x, w } = markGeom(m, scale);
      const d = px < x ? x - px : px > x + w ? px - (x + w) : 0;
      if (!best || d < best.d) best = { uuid: m.uuid, d, x, w };
    }
    return best;
  };

  const { cursorIndex, cursorMark, onKeyDown, onFocus } = useBandCursor({ marks, onRange, onJump });
  const { dragging, rangeX, onPointerDown, onPointerMove, onPointerUp } = useBandBrush({
    scale,
    svgRef,
    range,
    onRange,
    onJump,
    nearestMark,
    onHover: setHover,
  });

  /** What a screen reader hears as the cursor moves. Identity, position, size and time — the same
   *  four things the mark encodes visually, since none of them survive as colour and height alone. */
  const announcement = cursorMark
    ? [
        `message ${cursorIndex + 1} of ${marks.length}`,
        kindLabel(cursorMark.kind),
        usagePresent && cursorMark.value > 0 ? `${fmtTokens(cursorMark.value)} tokens` : null,
        new Date(cursorMark.t).toLocaleTimeString(),
        cursorMark.finding ? `${cursorMark.finding} security finding` : null,
        cursorMark.fileChange ? "changed files" : null,
      ]
        .filter(Boolean)
        .join(", ")
    : "";

  // Context occupancy, drawn as a line over the bars (see contextLine).
  const { peak: ctxPeak, points: ctxLine } = useMemo(() => contextLine(marks, (m) => markGeom(m, scale).x, PLOT_H), [marks, scale]);
  // The value a full-height bar stands for (see heightReference for why it is not the max).
  const reference = useMemo(() => heightReference(marks), [marks]);

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

  const heightOpts = { reference, usagePresent, plotH: PLOT_H, minH: MIN_BAR_H };

  const present = new Set<MarkKind>(marks.map((m) => m.kind));
  const hoveredMark = hover ? marks.find((m) => m.uuid === hover.uuid) : undefined;
  const hovered = hover && hoveredMark ? { mark: hoveredMark, x: hover.x, w: hover.w } : null;

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
        {/* Hidden only when the session has no gap long enough to collapse — then the two axes really
            are identical, which is the normal case for a subagent (96% contain no gap over a minute).
            Keyed off the session's gaps, NOT off `breaks`: literal mode collapses nothing by
            definition, so using `breaks` here would hide the control that switches back. */}
        {scale.collapsibleGaps > 0 && (
          <button
            type="button"
            className="link-btn tl-axis"
            onClick={() => onAxisMode(axisMode === "compressed" ? "literal" : "compressed")}
            data-tip={
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
          ref={svgRef}
          className={"tl-svg" + (dragging ? " is-dragging" : "")}
          width={width}
          height={SVG_H}
          role="group"
          aria-label={`Session timeline: ${caption}. Use the arrow keys to move between messages, Enter to open one, Shift with the arrows to select a range.`}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => setHover(null)}
        >
          {/* Breaks first, so marks paint over their edges rather than under them. */}
          {scale.breaks.map((b, i) => {
            // The event the break lands on decides the wording.
            const next = scale.points.find((p) => p.t >= b.t1);
            const nextIsPrompt = !!next && !!userPromptUuids?.has(next.uuid);
            return (
              <g
                key={"b" + i}
                className="tl-break"
                onDoubleClick={(ev) => {
                  ev.stopPropagation();
                  setExpandedGaps((prev) => toggleIn(prev, b.t0));
                }}
              >
                <rect x={b.x0} y={0} width={b.x1 - b.x0} height={PLOT_H} />
                <title>{breakLabel(b.durationMs, nextIsPrompt)} — double-click to show it to scale</title>
              </g>
            );
          })}
          {/* A gap the reader opened: drawn at its real duration, and still double-clickable so the
              expansion can be undone. */}
          {scale.expanded.map((g, i) => (
            <g
              key={"x" + i}
              className="tl-expanded"
              onDoubleClick={(ev) => {
                ev.stopPropagation();
                setExpandedGaps((prev) => {
                  const next = new Set(prev);
                  next.delete(g.t0);
                  return next;
                });
              }}
            >
              <rect x={g.x0} y={0} width={Math.max(g.x1 - g.x0, 1)} height={PLOT_H} />
              <title>{breakLabel(g.durationMs, false)} — shown in full; double-click to collapse it again</title>
            </g>
          ))}
          {marks.map((m) => (
            <MarkRect key={m.uuid} m={m} scale={scale} h={barHeight(m.value, heightOpts)} fill={fillFor(m.kind)} />
          ))}
          {/* Over the bars, not under them: at 44px the bars would hide most of it. `pointer-events`
              is off in CSS so it never steals a click meant for a mark. */}
          {ctxLine && <polyline className="tl-context" points={ctxLine} />}
          {hovered && (
            <rect className="tl-hover" x={hovered.x - 1} y={0} width={hovered.w + 2} height={PLOT_H} />
          )}
          {cursorMark && (
            <rect
              className="tl-cursor"
              x={scale.x(cursorMark.t) - 1}
              y={0}
              width={TICK_W}
              height={PLOT_H}
            />
          )}
          {rangeX && (
            <g className="tl-sel">
              <rect className="tl-sel-shade" x={0} y={0} width={Math.max(rangeX[0], 0)} height={PLOT_H} />
              <rect className="tl-sel-shade" x={rangeX[1]} y={0} width={Math.max(width - rangeX[1], 0)} height={PLOT_H} />
              <rect className="tl-sel-box" x={rangeX[0]} y={0} width={Math.max(rangeX[1] - rangeX[0], 1)} height={PLOT_H} />
              <rect className="tl-sel-handle" x={rangeX[0] - 1} y={0} width={2} height={PLOT_H} />
              <rect className="tl-sel-handle" x={rangeX[1] - 1} y={0} width={2} height={PLOT_H} />
            </g>
          )}
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

      {hovered && (
        // Positioned by the mark, not the pointer: it should not jitter while the reader moves along
        // the band, and it must stay put long enough to read.
        <div
          className={"tl-tip" + (hovered.x > width * 0.6 ? " is-right" : "")}
          style={hovered.x > width * 0.6 ? { right: Math.max(width - hovered.x, 0) } : { left: hovered.x }}
          aria-hidden="true"
        >
          <div className="tl-tip-head">
            {hovered.mark.turnSeq != null && <span className="tl-tip-turn">turn {hovered.mark.turnSeq}</span>}
            <span>{kindLabel(hovered.mark.kind)}</span>
          </div>
          <div className="tl-tip-row muted">
            {new Date(hovered.mark.t).toLocaleTimeString()}
            {usagePresent && hovered.mark.value > 0 ? ` · ${fmtTokens(hovered.mark.value)} tok` : ""}
            {hovered.mark.durationMs > 0 ? ` · ${fmtDuration(hovered.mark.durationMs)}` : ""}
            {hovered.mark.context > 0 ? ` · ${fmtTokens(hovered.mark.context)} context` : ""}
          </div>
          {(hovered.mark.error || hovered.mark.finding || hovered.mark.fileChange || hovered.mark.spawn) && (
            <div className="tl-tip-row">
              {hovered.mark.error && <span className="tl-tip-flag is-err">tool error</span>}
              {hovered.mark.finding && (
                <span className={"tl-tip-flag sev-" + hovered.mark.finding}>{hovered.mark.finding} finding</span>
              )}
              {hovered.mark.fileChange && (
                <span className="tl-tip-flag">
                  {hovered.mark.fileChangeCount} file{hovered.mark.fileChangeCount === 1 ? "" : "s"}
                </span>
              )}
              {hovered.mark.spawn && <span className="tl-tip-flag">subagent</span>}
            </div>
          )}
        </div>
      )}

      {/* The cursor is a visual mark; this is how it reaches a screen reader. Polite, because moving
          the cursor is navigation, not an alert — and deliberately NOT role="status": the search
          counter already owns that role on this page, and two status regions compete to be read.
          aria-atomic, so each move is announced as one whole line rather than a diff of the last. */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

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
        {/* The line needs its peak stated or it is a shape with no units. It is named "context", not
            "context used" or anything implying a budget: the corpus says a fuller context is not a
            worse one over most of the range. */}
        {ctxPeak > 0 && (
          <span className="tl-key" data-tip="Prompt size per message — input + cache-write + cache-read. Shape only; a fuller context is not a worse one.">
            <span className="tl-swatch is-line" />
            context, peak {fmtTokens(ctxPeak)}
          </span>
        )}
      </div>
    </div>
  );
}

function MarkRect({ m, scale, h, fill }: { m: Mark; scale: TimeScale; h: number; fill: string }) {
  const { x, w } = markGeom(m, scale);
  return <rect className="tl-mark" x={x} y={PLOT_H - h} width={w} height={h} rx={2} fill={fill} />;
}
