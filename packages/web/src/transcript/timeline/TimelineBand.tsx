/**
 * The session timeline band: a minimap of where the work, the waiting, and the audit-relevant events
 * are. Bespoke SVG rather than Recharts — the marks are a custom geometry (derived-duration spans over
 * a piecewise scale, with an annotation rail) that no chart library models, and the largest session in
 * the corpus is 1 632 events, well inside what SVG handles.
 *
 * Rendering only. Selection, zoom and click-to-jump arrive with the interaction layer; the props are
 * shaped for them but this component draws a static band.
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { EventNode, Finding, FileChangeRow } from "../../api";
import { fmtDuration, fmtTokens } from "../../format";
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
  onDomain: (d: [number, number] | null) => void;
}

/** Below this many pixels a pointer gesture is a click, not a drag. */
const DRAG_THRESHOLD = 3;
/** How far the pointer may sit from a mark and still be hovering it. Marks are 2–3px wide, which is
 *  far too small a target on its own — the hit area is deliberately much larger than the ink. */
const HOVER_RADIUS_PX = 12;

type Drag = { kind: "new" | "start" | "end"; anchor: number; x: number; pointerId: number; captured: boolean };

export function TimelineBand(props: TimelineBandProps) {
  const { events, findings, fileChanges, userPromptUuids, turnSeqById, axisMode, onAxisMode, metric, onMetric } = props;
  const { range, onRange, onJump, domain, onDomain } = props;
  const [ref, width] = useMeasuredWidth();
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // Idle gaps the reader has opened in place, keyed by the timestamp before them.
  const [expandedGaps, setExpandedGaps] = useState<ReadonlySet<number>>(() => new Set());
  // Keyboard cursor: an index into `marks`. The band is a single tab stop, and this is the roving
  // position within it — there is no native element that does this, so it is built by hand.
  const [cursor, setCursor] = useState(0);
  // Where a Shift+arrow extension started, so the selection grows from the anchor rather than from
  // wherever the cursor happens to be now.
  const [keyAnchor, setKeyAnchor] = useState<number | null>(null);
  // The mark under the pointer. Without it, clicking or brushing is a guess: the marks are only a few
  // pixels wide, and colour plus height say nothing about which message they are.
  const [hover, setHover] = useState<{ uuid: string; x: number } | null>(null);
  const { TIMELINE_COLORS, C } = useChartTokens();

  const usagePresent = hasUsage(events);

  // Esc clears the selection and leaves the domain alone — they are separate concepts (see props).
  useEffect(() => {
    if (!range) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      onRange(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [range, onRange]);
  // With no usage anywhere the metric is meaningless: heights go uniform and the toggle disappears,
  // rather than the band drawing a flat row of zero-height marks.
  const effectiveMetric: TokenMetric = usagePresent ? metric : "work";

  const scale = buildScale(events, {
    width,
    gapMs: axisMode === "literal" ? Infinity : undefined,
    ...(domain ? { domain } : {}),
    expandedGaps,
  });
  const marks = buildMarks({ events, points: scale.points, findings, fileChanges, turnSeqById, metric: effectiveMetric });

  const rangeX: [number, number] | null = range && !scale.degenerate ? [scale.x(range[0]), scale.x(range[1])] : null;

  /** A pointer within this many px of a selection edge grabs that handle instead of starting anew. */
  const HANDLE_GRAB = 6;
  const handleHit = (x: number): "start" | "end" | null => {
    if (!rangeX) return null;
    if (Math.abs(x - rangeX[0]) <= HANDLE_GRAB) return "start";
    if (Math.abs(x - rangeX[1]) <= HANDLE_GRAB) return "end";
    return null;
  };
  /** Resizing pivots on the edge you did NOT grab. */
  const handleAnchor = (h: "start" | "end"): number => (h === "start" ? rangeX![1] : rangeX![0]);

  const orderedRange = (a: number, b: number): [number, number] => {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    return [scale.t(lo), scale.t(hi)];
  };

  const nearestMark = (x: number) => {
    let best: { uuid: string; d: number; i: number } | null = null;
    marks.forEach((m, i) => {
      const d = Math.abs(scale.x(m.t) - x);
      if (!best || d < best.d) best = { uuid: m.uuid, d, i };
    });
    return best as { uuid: string; d: number; i: number } | null;
  };

  const cursorMark = marks[Math.min(cursor, marks.length - 1)] ?? null;

  /** What a screen reader hears as the cursor moves. Identity, position, size and time — the same
   *  four things the mark encodes visually, since none of them survive as colour and height alone. */
  const announcement = cursorMark
    ? [
        `message ${Math.min(cursor, marks.length - 1) + 1} of ${marks.length}`,
        cursorMark.kind === "tool-error" ? "tool error" : cursorMark.kind,
        usagePresent && cursorMark.value > 0 ? `${fmtTokens(cursorMark.value)} tokens` : null,
        new Date(cursorMark.t).toLocaleTimeString(),
        cursorMark.finding ? `${cursorMark.finding} security finding` : null,
        cursorMark.fileChange ? "changed files" : null,
      ]
        .filter(Boolean)
        .join(", ")
    : "";

  const moveCursor = (next: number, extend: boolean) => {
    const clamped = Math.max(0, Math.min(next, marks.length - 1));
    setCursor(clamped);
    if (!extend) {
      setKeyAnchor(null);
      return;
    }
    const anchor = keyAnchor ?? Math.min(cursor, marks.length - 1);
    setKeyAnchor(anchor);
    const [lo, hi] = anchor <= clamped ? [anchor, clamped] : [clamped, anchor];
    onRange([marks[lo].t, marks[hi].t]);
  };

  const onKeyDown = (e: ReactKeyboardEvent<SVGSVGElement>) => {
    if (!marks.length) return;
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        moveCursor(cursor - 1, e.shiftKey);
        break;
      case "ArrowRight":
        e.preventDefault();
        moveCursor(cursor + 1, e.shiftKey);
        break;
      case "Home":
        e.preventDefault();
        moveCursor(0, e.shiftKey);
        break;
      case "End":
        e.preventDefault();
        moveCursor(marks.length - 1, e.shiftKey);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (cursorMark) onJump(cursorMark.uuid);
        break;
      default:
    }
  };

  /** Pointer x within the svg. */
  const localX = (e: { clientX: number }): number => {
    const box = svgRef.current?.getBoundingClientRect();
    return box ? e.clientX - box.left : 0;
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || scale.degenerate) return;
    const x = localX(e);
    const handle = handleHit(x);
    // Capture is taken LAZILY, once a drag really starts (below). Capturing here would retarget the
    // compatibility mouse events to this element, and the break markers' double-click — which opens a
    // single idle gap in place — would never reach them.
    const common = { x, pointerId: e.pointerId, captured: false };
    setDrag(handle ? { kind: handle, anchor: handleAnchor(handle), ...common } : { kind: "new", anchor: x, ...common });
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const px = localX(e);
    if (!drag) {
      const near = nearestMark(px);
      setHover(near && near.d <= HOVER_RADIUS_PX ? { uuid: near.uuid, x: scale.x(marks[near.i].t) } : null);
      return;
    }
    const x = px;
    const dragging = Math.abs(x - drag.anchor) >= DRAG_THRESHOLD;
    // Capture keeps a drag alive when the pointer leaves the band; it is an enhancement, so where it
    // is unavailable the drag must still work rather than throwing out of the handler.
    if (dragging && !drag.captured) e.currentTarget.setPointerCapture?.(drag.pointerId);
    setDrag({ ...drag, x, captured: drag.captured || dragging });
    // Live filtering while dragging: the point of a brush is watching the transcript narrow.
    if (dragging) onRange(orderedRange(drag.anchor, x));
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const x = localX(e);
    if (drag.captured && e.currentTarget.hasPointerCapture?.(drag.pointerId)) {
      e.currentTarget.releasePointerCapture?.(drag.pointerId);
    }
    setDrag(null);
    if (Math.abs(x - drag.anchor) < DRAG_THRESHOLD) {
      // A click, not a drag: jump to the nearest mark — unless the click was on a break marker, whose
      // own gesture is a double-click to open the gap. Without this the first click of that
      // double-click also jumps, which scrolls the page and moves the band out from under the second.
      const onGap = (e.target as Element | null)?.closest?.(".tl-break, .tl-expanded");
      if (drag.kind === "new" && !onGap) {
        const hit = nearestMark(x);
        if (hit) onJump(hit.uuid);
      }
      return;
    }
    onRange(orderedRange(drag.anchor, x));
  };

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
  const hoveredMark = hover ? marks.find((m) => m.uuid === hover.uuid) : undefined;
  const hovered = hover && hoveredMark ? { mark: hoveredMark, x: hover.x } : null;

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
          ref={svgRef}
          className={"tl-svg" + (drag ? " is-dragging" : "")}
          width={width}
          height={SVG_H}
          role="group"
          aria-label={`Session timeline: ${caption}. Use the arrow keys to move between messages, Enter to open one, Shift with the arrows to select a range.`}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onFocus={() => setCursor((c) => Math.min(c, Math.max(marks.length - 1, 0)))}
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
                  setExpandedGaps((prev) => {
                    const next = new Set(prev);
                    if (next.has(b.t0)) next.delete(b.t0);
                    else next.add(b.t0);
                    return next;
                  });
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
            <MarkRect key={m.uuid} m={m} scale={scale} h={barHeight(m.value)} fill={fillFor(m.kind)} />
          ))}
          {hovered && (
            <rect className="tl-hover" x={hovered.x - 2} y={0} width={4} height={PLOT_H} />
          )}
          {cursorMark && (
            <rect
              className="tl-cursor"
              x={scale.x(cursorMark.t) - 1}
              y={0}
              width={Math.max(TICK_W, 2)}
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
            <span>{hovered.mark.kind === "tool-error" ? "tool error" : hovered.mark.kind}</span>
          </div>
          <div className="tl-tip-row muted">
            {new Date(hovered.mark.t).toLocaleTimeString()}
            {usagePresent && hovered.mark.value > 0 ? ` · ${fmtTokens(hovered.mark.value)} tok` : ""}
            {hovered.mark.durationMs > 0 ? ` · ${fmtDuration(hovered.mark.durationMs)}` : ""}
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
