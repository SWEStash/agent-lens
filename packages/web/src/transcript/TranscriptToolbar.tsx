/** The transcript's control strip: collapse/expand all turns, the hide-tools toggle, and the
 * markdown/raw format switch. The collapse control only appears once there is more than one turn. */
import type { MsgFormat } from "./contexts";

export function TranscriptToolbar({
  turnCount,
  anyOpen,
  onToggleAll,
  hideTools,
  onToggleHideTools,
  format,
  onChooseFormat,
}: {
  turnCount: number;
  anyOpen: boolean;
  onToggleAll: () => void;
  hideTools: boolean;
  onToggleHideTools: () => void;
  format: MsgFormat;
  onChooseFormat: (f: MsgFormat) => void;
}) {
  return (
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
  );
}
