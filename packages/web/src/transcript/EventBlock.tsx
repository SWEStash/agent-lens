import { useContext, useId, useState } from "react";
import type { EventNode } from "../api";
import { fmtDate, shortModel } from "../format";
import CopyButton from "../CopyButton";
import { FlashContext, HideToolsContext } from "./contexts";
import { parseCommand, parseTaskNotification } from "./parse";
import { CollapsibleText, CommandBlock, TaskNotificationBlock } from "./Message";
import { ToolRender, toolVisible } from "./tools";

export function EventBlock({ e }: { e: EventNode }) {
  const [showThinking, setShowThinking] = useState(false);
  const thinkId = useId();
  const hideTools = useContext(HideToolsContext);
  const flashUuid = useContext(FlashContext);
  const who = e.role || e.type;
  const icon = who === "user" ? "👤" : who === "assistant" ? "🤖" : "⚙️";
  const visibleTools = e.toolCalls.filter((t) => toolVisible(t, hideTools));
  const hasBody = e.text || e.thinking || visibleTools.length;
  if (!hasBody) return null;
  const cmd = e.text ? parseCommand(e.text) : null;
  const notif = e.text && !cmd ? parseTaskNotification(e.text) : null;
  // What the message-level copy button grabs: the visible body, else the thinking text.
  const copyText = e.text || e.thinking || "";
  return (
    // id lets a security finding (or any deep link) anchor to the exact message via #ev-<event_uuid>.
    <div id={"ev-" + e.uuid} className={"event ev-" + who + (flashUuid === e.uuid ? " ev-flagged" : "")}>
      <div className="ev-meta">
        <span className="ev-who">
          {icon} {who}
        </span>
        {e.model && <span className="tag">{shortModel(e.model)}</span>}
        {e.is_sidechain ? <span className="tag subagent">subagent</span> : null}
        <span className="muted ev-time">{fmtDate(e.timestamp)}</span>
        {copyText && <CopyButton text={copyText} className="ev-copy copy-hover" title="Copy message" />}
      </div>
      {e.thinking && (
        <div className="thinking">
          <button className="thinking-toggle" aria-expanded={showThinking} aria-controls={thinkId} onClick={() => setShowThinking((s) => !s)}>
            🧠 thinking {showThinking ? "▾" : "▸"}
          </button>
          {showThinking && (
            <div className="code-block">
              <CopyButton text={e.thinking} className="copy-corner" title="Copy thinking" />
              <pre id={thinkId} className="thinking-body">{e.thinking}</pre>
            </div>
          )}
        </div>
      )}
      {e.text && (cmd ? <CommandBlock cmd={cmd} /> : notif ? <TaskNotificationBlock n={notif} /> : <CollapsibleText text={e.text} />)}
      {visibleTools.map((t, i) => (
        <ToolRender key={i} t={t} hideTools={hideTools} />
      ))}
    </div>
  );
}
