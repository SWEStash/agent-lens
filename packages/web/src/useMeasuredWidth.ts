import { useEffect, useRef, useState } from "react";

/** Track an element's content width. Attach the ref to the element to measure. Before the first
 *  observation lands — and in jsdom, which has no ResizeObserver — width is 0, which callers treat as
 *  "not laid out yet". */
export function useMeasuredWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}
