/** The floating match navigator: term, position, ◂/▸ and clear, pinned to the viewport.
 *
 * Stepping through matches scrolls the transcript, which takes the toolbar's search box off screen —
 * so from the second match on, ◂/▸ and the counter were out of sight and Enter was a blind jump. This
 * follows the reader down the page instead.
 *
 * It's floated rather than sticky because `.turn-head` already holds the sticky top slot, and which
 * turn you're reading is context worth keeping. It also only appears once the toolbar's box is off
 * screen (see SearchBar), so the two are never both visible.
 *
 * Deliberately NOT a live region: the toolbar counter is the one `role="status"`, and it announces
 * whether or not it's in the viewport. Two would double every announcement.
 */
export function SearchNav({
  query,
  total,
  index,
  onPrev,
  onNext,
  onClear,
  onBackToBox,
}: {
  query: string;
  total: number;
  index: number;
  onPrev: () => void;
  onNext: () => void;
  onClear: () => void;
  /** Return to the toolbar's input — the only way to edit the term without scrolling for it. */
  onBackToBox: () => void;
}) {
  return (
    <div className="search-nav" role="group" aria-label="Search matches">
      {/* The term and position are plain text, not the button's label: an aria-label describing the
          action ("back to the search box") wouldn't contain the visible text, which is what speech
          input users say to activate it (WCAG 2.5.3). The icon carries the action instead. */}
      <button type="button" className="ghost small sn-back" aria-label="Back to the search box" onClick={onBackToBox}>
        🔍
      </button>
      <span className="sn-term">
        <span className="sn-q">{query}</span>
        <span className="sn-pos">
          {index + 1}/{total}
        </span>
      </span>
      <button type="button" className="ghost small" aria-label="Previous match" onClick={onPrev}>
        ◂
      </button>
      <button type="button" className="ghost small" aria-label="Next match" onClick={onNext}>
        ▸
      </button>
      <button type="button" className="ghost small" aria-label="Clear search" onClick={onClear}>
        ✕
      </button>
    </div>
  );
}
