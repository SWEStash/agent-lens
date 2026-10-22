import { useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { TimeScale } from "./scale";

/** A pointer within this many px of a selection edge grabs that handle instead of starting anew. */
const HANDLE_GRAB = 6;
/** Below this many pixels a pointer gesture is a click, not a drag. */
const DRAG_THRESHOLD = 3;
/** How far the pointer may sit from a mark and still be hovering it. Marks are 2–3px wide, which is
 *  far too small a target on its own — the hit area is deliberately much larger than the ink. */
const HOVER_RADIUS_PX = 12;

type Drag = { kind: "new" | "start" | "end"; anchor: number; x: number; pointerId: number; captured: boolean };

export interface NearMark {
  uuid: string;
  /** Distance in px from the pointer to the mark's span; 0 when on it. */
  d: number;
  x: number;
  w: number;
}

/**
 * The band's pointer gestures: drag to select a range (live, so the transcript narrows as you brush),
 * grab a selection edge to resize it, click to jump to the nearest message, and hover to name it.
 */
export function useBandBrush({
  scale,
  svgRef,
  range,
  onRange,
  onJump,
  nearestMark,
  onHover,
}: {
  scale: TimeScale;
  svgRef: RefObject<SVGSVGElement | null>;
  range: [number, number] | null;
  onRange: (r: [number, number] | null) => void;
  onJump: (uuid: string) => void;
  nearestMark: (px: number) => NearMark | null;
  onHover: (h: { uuid: string; x: number; w: number } | null) => void;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);

  const rangeX: [number, number] | null = range && !scale.degenerate ? [scale.x(range[0]), scale.x(range[1])] : null;

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
      onHover(near && near.d <= HOVER_RADIUS_PX ? { uuid: near.uuid, x: near.x, w: near.w } : null);
      return;
    }
    const dragging = Math.abs(px - drag.anchor) >= DRAG_THRESHOLD;
    // Capture keeps a drag alive when the pointer leaves the band; it is an enhancement, so where it
    // is unavailable the drag must still work rather than throwing out of the handler.
    if (dragging && !drag.captured) e.currentTarget.setPointerCapture?.(drag.pointerId);
    setDrag({ ...drag, x: px, captured: drag.captured || dragging });
    // Live filtering while dragging: the point of a brush is watching the transcript narrow.
    if (dragging) onRange(orderedRange(drag.anchor, px));
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

  return { dragging: drag != null, rangeX, onPointerDown, onPointerMove, onPointerUp };
}
