import { useState, type ReactNode } from "react";

/** Default rows shown for a ranked bar list before the user expands it ("show all"). Keeps every card
 * at the standard height so grid rows stay even; the full list is one click away. */
export const TOP_N = 8;
/** Approx px per horizontal bar row, used to size a card when it is expanded to show its full list. */
export const ROW_PX = 26;

export interface Expanded {
  /** Slice a ranked list to the top N unless the card `id` is expanded. */
  topN: <T>(arr: T[], id: string) => T[];
  /** Grow just this card's body while it is expanded; `undefined` keeps the shared `--chart-h`. */
  expandHeight: (id: string, total: number, rowPx?: number) => number | undefined;
  /** The card header's show-all/show-top-N toggle, or `undefined` when the list already fits. */
  expandBtn: (id: string, total: number) => ReactNode;
}

/** Which ranked bar cards are expanded to their full list (see TOP_N). Ephemeral view state — the
 * three helpers are shared by every ranked card, so they live together rather than being re-derived
 * per chart. */
export function useExpanded(): Expanded {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const topN = <T,>(arr: T[], id: string): T[] => (expanded.has(id) ? arr : arr.slice(0, TOP_N));
  const expandHeight = (id: string, total: number, rowPx = ROW_PX): number | undefined =>
    expanded.has(id) ? Math.max(240, total * rowPx) : undefined;
  const expandBtn = (id: string, total: number): ReactNode => {
    if (total <= TOP_N) return undefined;
    return (
      <button type="button" className="link-btn" onClick={() => toggleExpand(id)}>
        {expanded.has(id) ? `show top ${TOP_N}` : `show all (${total})`}
      </button>
    );
  };

  return { topN, expandHeight, expandBtn };
}
