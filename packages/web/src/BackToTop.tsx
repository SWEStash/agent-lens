/** Return to the top of a long page.
 *
 * A transcript runs to hundreds of messages, and once the reader is deep in one the header — the
 * title, the classification, the timeline, the search box — is a long scroll away. The session list,
 * the files index and the security list get long the same way. The browser's back button is not the
 * answer: it leaves the page entirely.
 *
 * Focus moves as well as the scroll position. Scrolling alone leaves a keyboard reader's focus where
 * it was, so the next Tab would jump them straight back down the page.
 */
import { useEffect, useState } from "react";

/** How far down the page the button becomes useful. Roughly one viewport. */
const SHOW_AFTER_PX = 700;

export default function BackToTop() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > SHOW_AFTER_PX);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!show) return null;

  const toTop = () => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
    // Hand focus back to the top of the page so tabbing resumes from there rather than from wherever
    // the reader had scrolled to. `#main` is the app shell's landmark and already takes focus.
    document.getElementById("main")?.focus({ preventScroll: true });
  };

  return (
    <button type="button" className="to-top" onClick={toTop} data-tip="Back to top">
      <span aria-hidden="true">↑</span>
      <span className="sr-only">Back to top</span>
    </button>
  );
}
