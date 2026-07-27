import { useEffect, useRef } from "react";

/** Calls `onOutside` when a mousedown lands outside the returned ref's element, while `enabled`.
 * We only listen for `mousedown`: a document-level `focusin` listener crashes Chrome's renderer
 * (SIGILL) during the synthetic focus a `<label>` click forwards to its checkbox inside a
 * `<details>`. Mousedown (not click) also beats the popup's own blur handling. */
export function useOutsideClick<T extends HTMLElement>(onOutside: () => void, enabled = true) {
  const ref = useRef<T>(null);
  // Keep the latest callback without re-subscribing on every render.
  const handler = useRef(onOutside);
  handler.current = onOutside;

  useEffect(() => {
    if (!enabled) return;
    const onDoc = (e: Event) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node)) handler.current();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [enabled]);

  return ref;
}

/** A native `<details>` gives keyboard/focus behaviour for free but stays open on outside clicks.
 * This closes it (clears `open`) when a mousedown lands outside — the dismiss behaviour the
 * FilterSelect dropdown has, on the elements that manage their own open state in the DOM. */
export function useDetailsAutoClose() {
  const ref = useOutsideClick<HTMLDetailsElement>(() => {
    if (ref.current?.open) ref.current.open = false;
  });
  return ref;
}
