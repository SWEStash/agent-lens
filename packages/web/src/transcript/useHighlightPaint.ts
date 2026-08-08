/** Paints every on-screen occurrence of the search term inside the transcript.
 *
 * Done with the CSS Custom Highlight API (`CSS.highlights` + `::highlight(al-search)`) rather than by
 * wrapping matches in `<mark>` at render time. The transcript renders through many unrelated paths —
 * a react-markdown AST, a raw `<div>`, the thinking `<pre>`, the shell console, the Edit diff, tool
 * chips — and marking up each one would mean a matching change in every renderer. Ranges over the
 * rendered text nodes cover all of them at once and mutate no DOM, so React never sees it.
 *
 * Where the API is missing (older browsers, jsdom) this is a no-op: the counter, the per-turn badges,
 * the auto-expansion and the scroll-and-flash all still work, only the inline tint is absent. That is
 * also why the tests assert the match model and navigation rather than the paint.
 */
import { useEffect, type RefObject } from "react";
import { MIN_QUERY } from "./search";

const HIGHLIGHT_NAME = "al-search";

export function useHighlightPaint(containerRef: RefObject<HTMLElement>, query: string) {
  useEffect(() => {
    const root = containerRef.current;
    const registry = (CSS as unknown as { highlights?: Map<string, unknown> } | undefined)?.highlights;
    const Ctor = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (!root || !registry || !Ctor) return;

    const needle = query.trim().toLowerCase();
    let raf = 0;

    const paint = () => {
      raf = 0;
      registry.delete(HIGHLIGHT_NAME);
      if (needle.length < MIN_QUERY) return;
      const ranges: Range[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      // Each occurrence is found within a single text node, so a term split across element
      // boundaries by markdown (`**AWS**_SECRET`) counts in the model but isn't tinted.
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const hay = node.nodeValue?.toLowerCase();
        if (!hay) continue;
        for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
          const range = new Range();
          range.setStart(node, i);
          range.setEnd(node, i + needle.length);
          ranges.push(range);
        }
      }
      if (ranges.length) registry.set(HIGHLIGHT_NAME, new Ctor(...ranges));
    };

    paint();

    // Ranges go stale whenever the rendered text changes, and it changes from a dozen places: a turn
    // expanding, "show more", the thinking toggle, hide-tools, the markdown/raw switch. Watching the
    // subtree covers all of them without each having to know about search. Highlights mutate no DOM,
    // so this can't re-trigger itself.
    const observer = new MutationObserver(() => {
      if (!raf) raf = requestAnimationFrame(paint);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });

    return () => {
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
      registry.delete(HIGHLIGHT_NAME);
    };
  }, [containerRef, query]);
}
