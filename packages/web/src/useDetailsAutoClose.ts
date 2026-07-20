import { useEffect, useRef } from "react";

/** A native <details> gives keyboard/focus behaviour for free but stays open on outside clicks.
 * This hook closes it (clears `open`) when a mousedown lands outside the element — matching the
 * FilterSelect dropdown's dismiss-on-outside-click behaviour. We only listen for `mousedown`: a
 * document-level `focusin` listener crashes Chrome's renderer (SIGILL) during the synthetic focus a
 * <label> click forwards to its checkbox inside a <details>. */
export function useDetailsAutoClose() {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const onDoc = (e: Event) => {
      const el = ref.current;
      if (el?.open && !el.contains(e.target as Node)) el.open = false;
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  return ref;
}
