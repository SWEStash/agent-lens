import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Mark } from "./marks";

/**
 * The band's keyboard cursor. The band is a single tab stop and this is the roving position within it
 * (there is no native element that does this, so it is built by hand): arrows and Home/End move it,
 * Shift extends a selection from where the extension started, and Enter or Space opens the message.
 */
export function useBandCursor({
  marks,
  onRange,
  onJump,
}: {
  marks: readonly Mark[];
  onRange: (r: [number, number] | null) => void;
  onJump: (uuid: string) => void;
}) {
  // An index into `marks`.
  const [cursor, setCursor] = useState(0);
  // Where a Shift+arrow extension started, so the selection grows from the anchor rather than from
  // wherever the cursor happens to be now.
  const [keyAnchor, setKeyAnchor] = useState<number | null>(null);

  const cursorIndex = Math.min(cursor, marks.length - 1);
  const cursorMark = marks[cursorIndex] ?? null;

  const moveCursor = (next: number, extend: boolean) => {
    const clamped = Math.max(0, Math.min(next, marks.length - 1));
    setCursor(clamped);
    if (!extend) {
      setKeyAnchor(null);
      return;
    }
    const anchor = keyAnchor ?? cursorIndex;
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

  /** On focus, pull a stale cursor back inside the current marks. */
  const onFocus = () => setCursor((c) => Math.min(c, Math.max(marks.length - 1, 0)));

  return { cursorIndex, cursorMark, onKeyDown, onFocus };
}
