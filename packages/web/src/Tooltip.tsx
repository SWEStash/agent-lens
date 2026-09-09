/**
 * The app's one hover/focus tooltip.
 *
 * Native `title=` was doing this job everywhere, which meant the OS drew it: a different font, a
 * different size, and a look that had nothing to do with the tooltips the dashboard charts draw
 * themselves (recharts, styled from the chart tokens in charts/theme.tsx). Every explanatory hover in
 * the app now carries `data-tip="…"` instead, and this layer renders all of them with the chart
 * tooltip's own surface — same panel, border, radius and 12px type.
 *
 * It is a single delegated listener rather than a component per tooltip: there are ~90 hover hints
 * across the app, most on plain `<span>` stats, and wrapping each one in a component would have
 * meant touching every layout it sits in. `data-tip` is also the whole API — add the attribute and
 * the hint works, exactly like `title` did.
 *
 * `data-tip` is a hint, never the accessible name: an icon-only control still needs its own
 * `aria-label` (the attribute mirrors into `aria-describedby` while shown, which supplements a name
 * but does not supply one).
 */
import { useEffect, useRef, useState } from "react";

/** Matches the native-title dwell closely enough to stay unobtrusive while scanning a dense row. */
const SHOW_DELAY_MS = 350;
const GAP = 8; // px between the anchor and the tip
const MARGIN = 8; // px kept clear of the viewport edges

interface TipState {
  text: string;
  x: number;
  y: number;
  /** False until the measuring pass has run: the first paint is needed to size the box, and showing
   *  it at the pre-measurement guess makes the tip visibly jump. */
  placed: boolean;
}

export function TooltipLayer() {
  const [tip, setTip] = useState<TipState | null>(null);
  const elRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
    const hide = () => {
      clearTimer();
      const a = anchorRef.current;
      // Restore the describedby we borrowed; leaving it behind would point at a removed node.
      if (a && a.getAttribute("aria-describedby") === "app-tooltip") a.removeAttribute("aria-describedby");
      anchorRef.current = null;
      setTip(null);
    };
    const show = (el: HTMLElement, immediate: boolean) => {
      const text = el.getAttribute("data-tip");
      if (!text) return; // absent or empty → nothing to say, same as an empty title
      if (anchorRef.current === el) return;
      hide();
      anchorRef.current = el;
      const paint = () => {
        el.setAttribute("aria-describedby", "app-tooltip");
        const r = el.getBoundingClientRect();
        setTip({ text, x: r.left + r.width / 2, y: r.top, placed: false });
      };
      if (immediate) paint();
      else timerRef.current = window.setTimeout(paint, SHOW_DELAY_MS);
    };

    const over = (e: Event) => {
      const el = (e.target as Element | null)?.closest?.("[data-tip]") as HTMLElement | null;
      if (el) show(el, false);
      else if (anchorRef.current) hide();
    };
    // Keyboard users get it without the dwell — they have already committed by tabbing here.
    const focusIn = (e: FocusEvent) => {
      const el = (e.target as Element | null)?.closest?.("[data-tip]") as HTMLElement | null;
      if (el) show(el, true);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && hide();

    document.addEventListener("mouseover", over);
    document.addEventListener("focusin", focusIn);
    document.addEventListener("focusout", hide);
    document.addEventListener("keydown", key);
    // A tip pinned to a rect that has since moved is worse than no tip.
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("focusin", focusIn);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      clearTimer();
    };
  }, []);

  // Second pass: the tip is laid out above its anchor and clamped into the viewport, which needs its
  // measured size. Flips below when there is no room above (a stat row at the top of the page).
  useEffect(() => {
    const el = elRef.current;
    const anchor = anchorRef.current;
    if (!tip || tip.placed || !el || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const y = r.top - h - GAP < MARGIN ? r.bottom + GAP : r.top - h - GAP;
    const x = Math.min(Math.max(r.left + r.width / 2 - w / 2, MARGIN), Math.max(MARGIN, window.innerWidth - w - MARGIN));
    setTip({ ...tip, x, y, placed: true });
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      id="app-tooltip"
      role="tooltip"
      ref={elRef}
      className="app-tip"
      style={{ left: tip.x, top: tip.y, visibility: tip.placed ? "visible" : "hidden" }}
    >
      {tip.text}
    </div>
  );
}
