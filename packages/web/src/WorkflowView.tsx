import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type WorkflowAgent, type WorkflowDetail } from "./api";
import { fmtCost, fmtDate, fmtDuration, fmtTokens, shortModel } from "./format";
import { decodeEntities, looseParse, prettyJson, splitTruncation } from "./jsonish";
import ResultView from "./ResultView";
import LaunchView from "./LaunchView";
import CopyButton from "./CopyButton";

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
      <div className="launch-actions">
        <CopyButton text={recovered ? prettyJson(body) : body} label="result" title="Copy the returned result" />
      </div>
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

  // Prefer the runner's self-reported roll-up (d.run) over stats derived from ingested agent
  // transcripts — it stays correct when few/no agents were ingested (async still pending, or a run
  // that failed before fanning out). Cost stays derived (the sidecar reports no cost).
  const agentCount = d.run?.agent_count ?? d.stats.agent_count;
  const totalTokens = d.run?.total_tokens ?? d.stats.total_tokens;
  const durationMs = d.run?.duration_ms ?? d.stats.duration_ms;
  const phaseTitles = (d.run?.phases ?? []).map((p) => p?.title).filter((t): t is string => !!t);
  const logs = d.run?.logs ?? [];

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
          {d.run?.default_model && <span className="tag">{shortModel(d.run.default_model)}</span>}
          {d.parent?.id && (
            <span className="spawned-by">
              ↖ launched from{" "}
              <Link to={`/session/${d.parent.id}`}>{d.parent.title || d.parent.id.slice(0, 12)}</Link>
              {d.parent.turn_seq != null ? ` · turn ${d.parent.turn_seq + 1}` : ""}
            </span>
          )}
          {/* Prefer the runner's self-reported roll-up (authoritative even when 0 agent transcripts
              were ingested, e.g. a run that failed before fan-out); fall back to derived stats. */}
          <span>{agentCount} agent{agentCount === 1 ? "" : "s"}</span>
          <span>{fmtTokens(totalTokens)} tok</span>
          {d.run?.total_tool_calls != null && <span>{d.run.total_tool_calls} tool calls</span>}
          <span title="Estimated from ingested agent transcripts at API list prices (cache-aware)">{fmtCost(d.stats.total_cost)}</span>
          <span>{fmtDuration(durationMs)}</span>
          <span className="muted">{fmtDate(d.run?.started_at ?? d.stats.started_at)}</span>
        </div>
        {phaseTitles.length > 0 && (
          <div className="wf-phases">
            {phaseTitles.map((t, i) => (
              <span key={i} className="wf-phase-chip">
                {i > 0 && <span className="wf-phase-arrow" aria-hidden="true">→</span>}
                {t}
              </span>
            ))}
          </div>
        )}
      </div>

      {d.completion && (
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
      )}

      {/* The runner's concise per-item outcome lines (e.g. "skill#1: RED 3/5 GREEN 5/5"). */}
      {logs.length > 0 && (
        <details className="wf-logs" open={logs.length <= 20}>
          <summary>Run log · {logs.length} line{logs.length === 1 ? "" : "s"}</summary>
          <ul className="wf-log-list">
            {logs.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </details>
      )}

      {/* What was launched. The primary content for async runs with no completion yet (open); a
          reference detail once results are in. Falls back to the plain launch-ack summary. */}
      {d.input_json ? (
        <div className="wf-result wf-launch">
          {d.completion ? (
            <details>
              <summary>
                <h2>Launch payload</h2>
              </summary>
              <LaunchView raw={d.input_json} />
            </details>
          ) : (
            <>
              <h2>Launch payload</h2>
              {status === "async_launched" && (
                <p className="wf-result-summary muted">
                  Launched asynchronously — results will appear here once the run reports back.
                </p>
              )}
              <LaunchView raw={d.input_json} />
            </>
          )}
        </div>
      ) : !d.completion && d.result_summary ? (
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
