/** Enter / Shift+Enter stepping, shared by the toolbar search box and the floating navigator.
 *
 * Attached to each container rather than to the input, so it works from whatever inside them holds
 * focus — which, after clicking ▸ once, is the ▸ button rather than the box.
 *
 * Plain Enter is left alone when a button has focus: the browser already activates it, and ▸/◂ then
 * step anyway. Taking it over would double-step those two and, worse, would hijack ✕ and 🔍 into
 * navigating instead of doing what they say. Shift+Enter means nothing to a button, so it is always
 * ours.
 */
import type { KeyboardEvent } from "react";

export function searchNavKeys(onPrev: () => void, onNext: () => void, onClear: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClear();
      return;
    }
    if (e.key !== "Enter") return;
    if (e.shiftKey) {
      e.preventDefault();
      onPrev();
      return;
    }
    if ((e.target as HTMLElement).tagName === "BUTTON") return;
    e.preventDefault();
    onNext();
  };
}
