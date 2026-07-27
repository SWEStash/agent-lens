/** The transcript page header: back link, title, the session's stat row, and the three roll-up panels
 * (classification, security findings, files changed) that sit above the transcript itself. */
import { Link } from "react-router-dom";
import type { SessionDetail } from "../api";
import { fmtCost, fmtDate, fmtDuration, fmtTokens, tokenSplitTitle } from "../format";
import { ExportMenu } from "./ExportMenu";
import { ClassificationBadge } from "./Classification";
import { SecurityBanner } from "./Findings";
import { FilesChangedPanel } from "./FilesChanged";

export function SessionHeader({ d }: { d: SessionDetail }) {
  const s = d.session;
  return (
    <div className="detail-head">
      <Link to="/" className="back">
        ← all sessions
      </Link>
      <h1>{s.title || s.id.slice(0, 12)}</h1>
      <div className="detail-meta">
        <span><b>{s.source_id}</b></span>
        <span className="path">{s.project_path}</span>
        {s.is_sidechain ? <span className="tag subagent">subagent</span> : null}
        {d.parent && (
          <span className="spawned-by">
            ↖ spawned by{" "}
            <Link to={`/session/${d.parent.id}`}>{d.parent.title || d.parent.id.slice(0, 12)}</Link>
            {d.parent.turn_seq != null ? ` · turn ${d.parent.turn_seq + 1}` : ""}
          </span>
        )}
        <span>{d.turns.length} turns</span>
        <span>{s.event_count} events</span>
        <span title={tokenSplitTitle(s.token_split)}>{fmtTokens(s.tokens)} tok</span>
        <span title="Estimated at API list prices (cache-aware)">{fmtCost(s.cost)}</span>
        {s.tool_call_count > 0 && (
          <span
            className={s.tool_failure_count > 0 ? "tool-err-stat" : "muted"}
            title={
              "Tool calls that returned is_error, of " +
              s.tool_call_count +
              ". Failures = the agent's tool errored; declined/blocked = you rejected it or a guardrail blocked it " +
              "(heuristic split from the result text — not an API-reported distinction)."
            }
          >
            {s.tool_failure_count} failed
            {s.tool_rejection_count > 0 ? ` · ${s.tool_rejection_count} declined/blocked` : ""}
            {` of ${s.tool_call_count} tool calls`}
          </span>
        )}
        <span>{fmtDuration(s.duration_ms)}</span>
        <span className="muted">{fmtDate(s.started_at)}</span>
        <ExportMenu id={s.id} />
      </div>
      {d.classification && <ClassificationBadge c={d.classification} />}
      {d.findings && d.findings.length > 0 && <SecurityBanner findings={d.findings} sessionId={s.id} />}
      {d.file_changes && d.file_changes.length > 0 && (
        <FilesChangedPanel changes={d.file_changes} projectPath={s.project_path ?? null} />
      )}
    </div>
  );
}
