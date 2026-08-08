import { useContext, useId, useState } from "react";
import { Link } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FormatContext, SearchContext, WorkflowMapContext } from "./contexts";
import type { ParsedCommand, ParsedTaskNotification } from "./parse";
import { fieldMatches } from "./search";

/** Render a slash command as an outlined, monospace chip (the invocation) with its local output as a
 * muted result block — instead of the raw `<command-*>` markup. */
export function CommandBlock({ cmd }: { cmd: ParsedCommand }) {
  if (cmd.kind === "invocation")
    return (
      <div className="cmd">
        <span className="cmd-chip" title="Slash command">⌘ {cmd.name}</span>
        {cmd.args && <code className="cmd-args">{cmd.args}</code>}
      </div>
    );
  if (cmd.kind === "output")
    return (
      <div className="cmd-out">
        {cmd.stdout && cmd.stdout !== "(no content)" ? cmd.stdout : <span className="muted">no output</span>}
      </div>
    );
  return <div className="cmd-note muted small">⌘ local command context</div>;
}

/** Claude Code posts a `<task-notification>` user message when an async task (Workflow run, or a
 * backgrounded Agent) finishes. Rendered verbatim it's a wall of XML; we parse the inner tags so it
 * can show as a compact status card that links back to the workflow it reports on. */
/** Render a parsed task-notification as a status card: a status badge, the summary, and the task id —
 * plus a "view workflow →" link when the originating tool-use-id resolves to a Workflow run. */
export function TaskNotificationBlock({ n }: { n: ParsedTaskNotification }) {
  const wfMap = useContext(WorkflowMapContext);
  const runId = n.toolUseId ? wfMap.get(n.toolUseId) : undefined;
  const status = (n.status ?? "").toLowerCase();
  return (
    <div className="task-notif">
      <div className="task-notif-head">
        <span className="task-notif-icon" aria-hidden="true">🔔</span>
        {n.status && <span className={"tag task-status task-status-" + status}>{n.status}</span>}
        {n.taskId && <code className="task-notif-id">task {n.taskId}</code>}
        {runId && (
          <Link className="subagent-link small" to={`/workflow/${runId}`}>
            view workflow →
          </Link>
        )}
      </div>
      {n.summary && <div className="task-notif-summary">{n.summary}</div>}
    </div>
  );
}

/** A message body rendered per the active format: GitHub-flavored markdown (default) or the raw
 * text verbatim. The "text" class is kept on both so the clamp/fade styling targets either. */
function MessageBody({ text, id }: { text: string; id?: string }) {
  const format = useContext(FormatContext);
  if (format === "raw") {
    return <div className="text" id={id}>{text}</div>;
  }
  return (
    <div className="text md" id={id}>
      <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {text}
      </Markdown>
    </div>
  );
}

/** Open links in a new tab and keep them safe; react-markdown sanitizes by default (no raw HTML).
 * `node` is react-markdown's internal AST handle — drop it so it isn't emitted as a DOM attribute. */
const MD_COMPONENTS = {
  a: ({ node, ...props }: any) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

/** Long message bodies are clamped to a preview height with a show-more toggle so a single big
 * message doesn't force endless scrolling; short messages render in full untouched.
 *
 * The clamp hides text, so a search match can land below the fold. When find-in-session navigates to
 * *this* message and the term is in the clamped body, unclamp it — otherwise ▸ scrolls to a card whose
 * match isn't visible. Only the active message opens: unclamping every body containing the term would
 * expand half the transcript at once. `uuid` is what ties the message to the active hit. */
export function CollapsibleText({ text, uuid }: { text: string; uuid?: string }) {
  const long = text.length > 1400 || text.split("\n").length > 18;
  const [expanded, setExpanded] = useState(false);
  const search = useContext(SearchContext);
  const bodyId = useId();
  if (!long) return <MessageBody text={text} />;
  const revealed = expanded || (!!uuid && search.activeUuid === uuid && fieldMatches(text, search.query));
  return (
    <div className={"text-wrap" + (revealed ? "" : " is-clamped")}>
      <MessageBody text={text} id={bodyId} />
      <button
        className="ghost small show-more"
        aria-expanded={revealed}
        aria-controls={bodyId}
        onClick={() => setExpanded(!revealed)}
      >
        {revealed ? "Show less ▴" : "Show more ▾"}
      </button>
    </div>
  );
}
