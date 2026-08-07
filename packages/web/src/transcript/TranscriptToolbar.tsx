/** The transcript's control strip: find-in-session, collapse/expand all turns, the hide-tools toggle,
 * and the markdown/raw format switch. The collapse control only appears once there is more than one
 * turn. Search sits on its own row above the toggles — it's the widest control and the one most often
 * reached for, and pairing it with the toggles on one line wraps badly on narrow screens. */
import type { ReactNode } from "react";
import type { MsgFormat } from "./contexts";

export function TranscriptToolbar({
  search,
  turnCount,
  anyOpen,
  onToggleAll,
  hideTools,
  onToggleHideTools,
  format,
  onChooseFormat,
}: {
  search: ReactNode;
  turnCount: number;
  anyOpen: boolean;
  onToggleAll: () => void;
  hideTools: boolean;
  onToggleHideTools: () => void;
  format: MsgFormat;
  onChooseFormat: (f: MsgFormat) => void;
}) {
  return (
    <>
    {search}
    <div className="transcript-tools">
      {turnCount > 1 && (
        <>
          <span className="muted small">{turnCount} turns</span>
          <button className="ghost small" onClick={onToggleAll}>
            {anyOpen ? "Collapse all" : "Expand all"}
          </button>
        </>
      )}
      <button
        className={"ghost small" + (hideTools ? " is-active" : "")}
        aria-pressed={hideTools}
        onClick={onToggleHideTools}
        title="Hide Bash/Edit/Skill and other tool calls — show only assistant answers, plans and questions"
      >
        {hideTools ? "☑ " : "☐ "}Hide tool messages
      </button>
      <div className="format-toggle" role="group" aria-label="Message format">
        <button
          className={"ghost small" + (format === "markdown" ? " is-active" : "")}
          aria-pressed={format === "markdown"}
          onClick={() => onChooseFormat("markdown")}
        >
          Markdown
        </button>
        <button
          className={"ghost small" + (format === "raw" ? " is-active" : "")}
          aria-pressed={format === "raw"}
          onClick={() => onChooseFormat("raw")}
        >
          Raw
        </button>
      </div>
    </div>
    </>
  );
}
