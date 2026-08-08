/** Bring one message into view and flash it — expanding the turn holding it first, if the reader had
 * collapsed that turn (a collapsed turn renders no children at all, so there is nothing to scroll to
 * until it opens).
 *
 * Two callers share this: the `#ev-<uuid>` deep link (from a security finding, a file-change row) and
 * find-in-session's ◂/▸. They differ only in when a jump should repeat, which is what `token` carries:
 * the same jump runs once per token, so re-rendering doesn't re-scroll, but pressing ▸ again on a
 * session with a single match does.
 */
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { EventNode } from "../api";

export function useScrollToEvent(
  events: EventNode[] | undefined,
  targetUuid: string | null,
  token: string | null,
  collapsed: Set<string>,
  setCollapsed: Dispatch<SetStateAction<Set<string>>>,
): string | null {
  const [flashUuid, setFlashUuid] = useState<string | null>(null);

  // If the target sits in a collapsed turn, open that turn — the same one-time edit clicking its
  // header would make, so the reader can collapse it again afterwards. Returning `prev` unchanged when
  // there is nothing to open keeps this from queueing a pointless render.
  useEffect(() => {
    const turnId = targetUuid ? events?.find((e) => e.uuid === targetUuid)?.turn_id : null;
    if (!turnId) return;
    setCollapsed((prev) => {
      if (!prev.has(turnId)) return prev;
      const next = new Set(prev);
      next.delete(turnId);
      return next;
    });
  }, [events, targetUuid, token, setCollapsed]);

  // Scroll + flash once the target is actually in the DOM, which the effect above may have just
  // caused. This one only READS the collapsed set. The ref is a plain once-per-token guard: the same
  // jump should not re-scroll on every render, but an expansion landing a frame later must still be
  // able to complete a jump that had no element to find yet.
  const jumpedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!events || !targetUuid || !token) {
      jumpedFor.current = null;
      return;
    }
    if (jumpedFor.current === token) return;
    const el = document.getElementById("ev-" + targetUuid);
    if (!el) return;
    jumpedFor.current = token;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlashUuid(targetUuid);
    const t = window.setTimeout(() => setFlashUuid(null), 3000);
    return () => window.clearTimeout(t);
    // `collapsed` is here so an expansion by the effect above re-runs this one, which is what lets a
    // jump into a collapsed turn complete on the following render.
  }, [events, targetUuid, token, collapsed]);

  return flashUuid;
}
