import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type WorkflowAgent, type WorkflowDetail } from "./api";
import { fmtCost, fmtDate, fmtDuration, fmtTokens, shortModel } from "./format";
import ResultView from "./ResultView";

/** Flattened transcript text HTML-encodes a few characters (e.g. "->" → "-&gt;"); decode them so the
 * result reads correctly and JSON inside it parses. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#3?9;|&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Claude Code truncates large task-notification results, appending a literal
 * "(truncated N chars, full result in <path>)" note. Peel that off so the JSON body can be parsed and
 * the note shown separately. */
function splitTruncation(s: string): { body: string; note: string | null } {
  const m = s.match(/\s*\(\s*truncated[^)]*\)\s*$/i);
  if (!m || m.index == null) return { body: s, note: null };
  return { body: s.slice(0, m.index).trimEnd(), note: m[0].trim() };
}

/** Parse JSON that may be truncated mid-structure (Claude Code caps large results). Strict parse
 * first; on failure, recover the largest valid prefix by cutting back to the last completed element
 * boundary and closing the still-open brackets. Returns `{ value, repaired }`, or value=undefined if
 * nothing parseable could be recovered. String-aware so punctuation inside strings isn't miscounted. */
function looseParse(body: string): { value: unknown; repaired: boolean } {
  try {
    return { value: JSON.parse(body), repaired: false };
  } catch {
    /* fall through to best-effort recovery */
  }
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  let safe = -1;
  let safeStack: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") (stack.pop(), (safe = i + 1), (safeStack = [...stack]));
    else if (c === ",") (safe = i, (safeStack = [...stack])); // cut before the dangling element
  }
  if (safe < 0) return { value: undefined, repaired: false };
  const candidate = body.slice(0, safe) + safeStack.reverse().join("");
  try {
    return { value: JSON.parse(candidate), repaired: true };
  } catch {
    return { value: undefined, repaired: false };
  }
}

/** Render the workflow's returned result as a browsable, structured view (ResultView) — the way the
 * Claude Code workflows TUI makes sense of structured data — rather than a raw/pretty-printed dump.
 * Truncated results are best-effort parsed so the recoverable structure still renders; non-JSON
 * results fall back to markdown. Any "(truncated …)" note is surfaced separately. */
function ResultBody({ raw }: { raw: string }) {
  const { body, note } = splitTruncation(decodeEntities(raw));
  const jsonish = /^\s*[[{]/.test(body);
  const { value, repaired } = jsonish ? looseParse(body) : { value: undefined, repaired: false };
  const recovered = value !== undefined;
  return (
    <>
      {recovered ? (
        <div className="wf-result-body"><ResultView value={value} /></div>
      ) : (
        <div className="text md wf-result-body">
          <Markdown remarkPlugins={[remarkGfm]}>{body}</Markdown>
        </div>
      )}
      {(note || repaired) && (
        <div className="muted small wf-trunc">⚠ {note ?? "Result was truncated; showing the recoverable portion."}</div>
      )}
    </>
  );
}

/** One spawned-agent row in a workflow run, linking to its full transcript. Mirrors SessionView's
 * SubagentItem look so the two fan-out views read the same. */
function AgentRow({ a }: { a: WorkflowAgent }) {
  return (
    <li>
      <Link to={`/session/${a.id}`}>{a.title || a.id.slice(0, 12)}</Link>
      <span className="muted">
        {" "}· {(a.models ?? "").split(",").filter(Boolean).map(shortModel).join(", ") || "—"} ·{" "}
        {fmtTokens(a.tokens)} tok · {fmtCost(a.cost)}
        {a.duration_ms != null ? ` · ${fmtDuration(a.duration_ms)}` : ""}
      </span>
    </li>
  );
}

/** Detail page for a single Workflow-tool run (route /workflow/:run_id). Shows what launched it, the
 * roll-up stats for the fan-out, the workflow's returned result, and every spawned agent linked back
 * to its transcript. The companion to the session/subagent detail page for orchestration runs. */
export default function WorkflowView() {
  const { run_id } = useParams();
  const [d, setD] = useState<WorkflowDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setD(null);
    setError(null);
    api<WorkflowDetail>("/workflows/" + run_id)
      .then(setD)
      .catch((e) => setError(String(e)));
  }, [run_id]);

  if (error) return <div className="error" role="alert">{error}</div>;
  if (!d) return <div className="muted pad" role="status" aria-live="polite">Loading…</div>;
  const status = (d.status ?? "").toLowerCase();

  return (
    <div className="detail">
      <div className="detail-head">
        <Link to="/" className="back">
          ← all sessions
        </Link>
        <h1>🔀 {d.name || "workflow"}</h1>
        <div className="detail-meta">
          <code>{d.run_id}</code>
          {d.status && <span className={"tag task-status task-status-" + status}>{d.status}</span>}
          {d.parent?.id && (
            <span className="spawned-by">
              ↖ launched from{" "}
              <Link to={`/session/${d.parent.id}`}>{d.parent.title || d.parent.id.slice(0, 12)}</Link>
              {d.parent.turn_seq != null ? ` · turn ${d.parent.turn_seq + 1}` : ""}
            </span>
          )}
          <span>{d.stats.agent_count} agent{d.stats.agent_count === 1 ? "" : "s"}</span>
          <span>{fmtTokens(d.stats.total_tokens)} tok</span>
          <span title="Estimated at API list prices (cache-aware)">{fmtCost(d.stats.total_cost)}</span>
          <span>{fmtDuration(d.stats.duration_ms)}</span>
          <span className="muted">{fmtDate(d.stats.started_at)}</span>
        </div>
      </div>

      {d.completion ? (
        <div className="wf-result">
          <h2>
            Returned result
            {d.completion.status && (
              <span className={"tag task-status task-status-" + d.completion.status.toLowerCase()}>{d.completion.status}</span>
            )}
          </h2>
          {d.completion.summary && <p className="wf-result-summary">{decodeEntities(d.completion.summary)}</p>}
          {d.completion.result ? (
            <ResultBody raw={d.completion.result} />
          ) : (
            <div className="muted small">Completed with no returned payload.</div>
          )}
          {d.completion.failures && (
            <details className="wf-failures">
              <summary>failures</summary>
              <pre className="code wf-result-body">{decodeEntities(d.completion.failures)}</pre>
            </details>
          )}
        </div>
      ) : d.result_summary ? (
        // No completion notification ingested yet — show the launch acknowledgment as a fallback.
        <div className="wf-result">
          <h2>Workflow launch</h2>
          <div className="text md">
            <Markdown remarkPlugins={[remarkGfm]}>{d.result_summary}</Markdown>
          </div>
        </div>
      ) : null}

      <div className="subagents">
        <h2>Agents ({d.agents.length})</h2>
        {d.agents.length === 0 ? (
          <div className="muted pad" role="status">No agent transcripts ingested for this run yet.</div>
        ) : (
          <ul>
            {d.agents.map((a) => (
              <AgentRow key={a.id} a={a} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
