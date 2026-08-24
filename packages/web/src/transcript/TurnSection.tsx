import { useId } from "react";
import type { EventNode } from "../api";
import { fmtDuration } from "../format";
import { previewLabel } from "./parse";
import { EventBlock } from "./EventBlock";

/** A collapsible turn: the header stays visible (turn no., prompt preview, message count, duration)
 * so a long transcript can be scanned and navigated; the messages render only while expanded.
 *
 * `matches` is how many of those messages hold the active find-in-session term. It matters most while
 * collapsed — that content isn't rendered, so the badge on the header is the reader's only sign that
 * anything in there matched. */
export function TurnSection({
  turn,
  events,
  matches = 0,
  total,
  open,
  onToggle,
}: {
  turn: any;
  events: EventNode[];
  matches?: number;
  /** The turn's message count BEFORE the timeline's range filter, when one is active. */
  total?: number;
  open: boolean;
  onToggle: () => void;
}) {
  const regionId = useId();
  return (
    <section className={"turn" + (open ? " is-open" : "")}>
      <button className="turn-head" aria-expanded={open} aria-controls={regionId} onClick={onToggle}>
        <span className="chev turn-chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="turn-no">turn {turn.seq + 1}</span>
        {turn.prompt_preview ? <span className="turn-preview">{previewLabel(turn.prompt_preview)}</span> : null}
        {matches > 0 && (
          <span className="turn-matches" title={`${matches} message${matches === 1 ? "" : "s"} match the search`}>
            {matches}
          </span>
        )}
        <span className="turn-stats muted">
          {total != null && total > events.length ? `${events.length} of ${total}` : events.length} msg
          {(total ?? events.length) === 1 ? "" : "s"}
          {turn.duration_ms ? " · " + fmtDuration(turn.duration_ms) : ""}
        </span>
      </button>
      <div id={regionId} className="turn-body" role="region" aria-label={`turn ${turn.seq + 1} messages`}>
        {open && events.map((e) => <EventBlock key={e.uuid} e={e} />)}
      </div>
    </section>
  );
}
