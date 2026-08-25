/**
 * The enlarged view of a dashboard chart card.
 *
 * Lives here rather than inside `ChartCard` because it is the app's only modal dialog, and the
 * dialog mechanics — modality, the focus trap, focus restoration — are the whole of it. Portalled to
 * `document.body` so no card's `overflow` or stacking context can clip it.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

export function ChartModal({
  title,
  labelId,
  onClose,
  children,
}: {
  title: string;
  labelId: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Restore focus to whatever opened the dialog — for a keyboard reader that is the card's own
    // expand button, and landing back on the page body instead loses their place entirely.
    const opener = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();

    // `inert` on the app root is what actually makes the dialog modal: it takes the rest of the page
    // out of the tab order AND out of the accessibility tree, which aria-modal alone does not do.
    // The dialog is portalled to <body>, so it sits outside the inert subtree.
    const root = document.getElementById("root");
    root?.setAttribute("inert", "");
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    return () => {
      root?.removeAttribute("inert");
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, []);

  // Tab still has to cycle inside the panel: `inert` keeps focus out of the page, but without this
  // it walks off the last control into the browser's own chrome.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const items = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (!items.length) return;
    const edge = e.shiftKey ? items[0] : items[items.length - 1];
    if (document.activeElement === edge) {
      e.preventDefault();
      (e.shiftKey ? items[items.length - 1] : items[0]).focus();
    }
  };

  return createPortal(
    <div className="chart-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="chart-modal" role="dialog" aria-modal="true" aria-labelledby={labelId} ref={panel} onKeyDown={onKeyDown}>
        {children}
        <button type="button" className="chart-modal-close" ref={closeBtn} onClick={onClose} aria-label={`Close "${title}"`}>
          ✕
        </button>
      </div>
    </div>,
    document.body,
  );
}
