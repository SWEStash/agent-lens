/** Find-in-session: the transcript's search box, match counter and ◂/▸ navigation.
 *
 * Navigation steps message by message, not occurrence by occurrence — a transcript is read as a
 * sequence of messages, and matches inside a collapsed turn have no DOM position to step through
 * anyway. Every occurrence within a message is still tinted.
 */
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { MIN_QUERY } from "./search";
import { SearchNav } from "./SearchNav";
import { searchNavKeys } from "./searchKeys";

/** Quiet period before a keystroke reaches the URL, so find-as-you-type doesn't fill the history. */
const DEBOUNCE_MS = 150;

export function SearchBar({
  query,
  onQuery,
  total,
  index,
  onPrev,
  onNext,
  inputRef,
}: {
  query: string;
  onQuery: (q: string) => void;
  total: number;
  /** 0-based position in the hit ring; displayed 1-based. */
  index: number;
  onPrev: () => void;
  onNext: () => void;
  inputRef: MutableRefObject<HTMLInputElement | null>;
}) {
  const [value, setValue] = useState(query);
  const timer = useRef(0);

  // Navigating scrolls this box out of view, and the floating navigator takes over from there. Tracked
  // by observing the box itself rather than a scroll offset, so it holds up however the page reflows.
  const formRef = useRef<HTMLFormElement>(null);
  const [boxOnScreen, setBoxOnScreen] = useState(true);
  useEffect(() => {
    const el = formRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setBoxOnScreen(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Adopt a query that changed elsewhere — landing on `?q=…`, or the clear button. Debounced pushes
  // always carry the newest value, so this only ever echoes back what the box already holds.
  const lastQuery = useRef(query);
  if (lastQuery.current !== query) {
    lastQuery.current = query;
    setValue(query);
  }

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const type = (next: string) => {
    setValue(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onQuery(next), DEBOUNCE_MS);
  };

  const clear = () => {
    window.clearTimeout(timer.current);
    setValue("");
    onQuery("");
    inputRef.current?.focus();
  };

  const searching = value.trim().length >= MIN_QUERY;

  return (
    <>
    <form
      ref={formRef}
      className="transcript-search"
      role="search"
      onSubmit={(e) => e.preventDefault()}
      onKeyDown={searchNavKeys(onPrev, onNext, clear)}
    >
      <span className="ts-icon" aria-hidden="true">
        🔍
      </span>
      <input
        ref={inputRef}
        type="search"
        aria-label="Find in this session"
        placeholder="Find in session…"
        value={value}
        onChange={(e) => type(e.target.value)}
      />
      {/* One live region for both outcomes, so a screen reader hears the count change or "no matches"
          without the surrounding controls being re-announced. */}
      <span className="ts-count muted small" role="status" aria-live="polite">
        {!searching ? "" : total === 0 ? "No matches" : `${index + 1} of ${total} message${total === 1 ? "" : "s"}`}
      </span>
      <button type="button" className="ghost small" aria-label="Previous match" disabled={total === 0} onClick={onPrev}>
        ◂
      </button>
      <button type="button" className="ghost small" aria-label="Next match" disabled={total === 0} onClick={onNext}>
        ▸
      </button>
      {value && (
        <button type="button" className="ghost small" aria-label="Clear search" onClick={clear}>
          ✕
        </button>
      )}
    </form>
    {total > 0 && !boxOnScreen && (
      <SearchNav
        query={query}
        total={total}
        index={index}
        onPrev={onPrev}
        onNext={onNext}
        onClear={clear}
        onBackToBox={() => inputRef.current?.focus()}
      />
    )}
    </>
  );
}
