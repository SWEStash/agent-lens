import { useContext, useId, useState } from "react";
import type { EventNode, ToolCall } from "../api";
import { fmtDate, fmtTokens, shortModel, tokenSplitTitle, workTokens } from "../format";
import CopyButton from "../CopyButton";
import { FlashContext, HideToolsContext, JumpTargetContext, SearchContext } from "./contexts";
import { parseCommand, parseTaskNotification } from "./parse";
import { CollapsibleText, CommandBlock, TaskNotificationBlock } from "./Message";
import { fieldMatches, toolMatches } from "./search";
import { ToolRender, toolVisible } from "./tools";

export function EventBlock({ e }: { e: EventNode }) {
  const [showThinking, setShowThinking] = useState(false);
  const thinkId = useId();
  const hideTools = useContext(HideToolsContext);
  const flashUuid = useContext(FlashContext);
  const search = useContext(SearchContext);
  const jumpTarget = useContext(JumpTargetContext);
  // Thinking is collapsed by default, so a match inside it is invisible until opened. Open it when
  // find-in-session navigates here and the term is actually in the thinking text — same reasoning as
  // the clamped body in CollapsibleText.
  const thinkingRevealed = showThinking || (search.activeUuid === e.uuid && fieldMatches(e.thinking, search.query));
  const who = e.role || e.type;
  const icon = who === "user" ? "👤" : who === "assistant" ? "🤖" : "⚙️";
  // Search covers tool payloads whether or not they're hidden, so "hide tool messages" would otherwise
  // let ▸ land on a message with nothing to show — or, when a tool call is its only content, on a card
  // that doesn't render at all. A tool holding the active match overrides the toggle, the same way a
  // flagged one does; the toggle is about reading the conversation, not about narrowing a search.
  // A jump target reveals its tools for the same reason a search hit does: otherwise clicking a
  // timeline mark for a tool-only message scrolls to an element that "hide tool messages" never
  // rendered, and the jump silently does nothing.
  const revealed = (t: ToolCall) =>
    jumpTarget === e.uuid || (search.activeUuid === e.uuid && toolMatches(t, search.query));
  const visibleTools = e.toolCalls.filter((t) => toolVisible(t, hideTools) || revealed(t));
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
        {/* Only events with a token_usage row carry `usage` at all — most user and meta events have
            none, and get no chip rather than a "0 tok" one. The label is WORK tokens (see
            workTokens); the hover carries the full four-way split including cache-read. */}
        {e.usage && (
          <span className="muted ev-tokens" title={tokenSplitTitle(e.usage)}>
            {fmtTokens(workTokens(e.usage))} tok
          </span>
        )}
        <span className="muted ev-time">{fmtDate(e.timestamp)}</span>
        {copyText && <CopyButton text={copyText} className="ev-copy copy-hover" title="Copy message" />}
      </div>
      {e.thinking && (
        <div className="thinking">
          <button className="thinking-toggle" aria-expanded={thinkingRevealed} aria-controls={thinkId} onClick={() => setShowThinking(!thinkingRevealed)}>
            🧠 thinking {thinkingRevealed ? "▾" : "▸"}
          </button>
          {thinkingRevealed && (
            <div className="code-block">
              <CopyButton text={e.thinking} className="copy-corner" title="Copy thinking" />
              <pre id={thinkId} className="thinking-body">{e.thinking}</pre>
            </div>
          )}
        </div>
      )}
      {e.text && (cmd ? <CommandBlock cmd={cmd} /> : notif ? <TaskNotificationBlock n={notif} /> : <CollapsibleText text={e.text} uuid={e.uuid} />)}
      {visibleTools.map((t, i) => (
        <ToolRender key={i} t={t} hideTools={hideTools && !revealed(t)} />
      ))}
    </div>
  );
}
