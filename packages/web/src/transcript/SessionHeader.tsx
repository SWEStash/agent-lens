/** The transcript page header: back link, title, the session's stat row, and the three roll-up panels
 * (classification, security findings, files changed) that sit above the transcript itself. */
import { Link } from "react-router-dom";
import type { SessionDetail } from "../api";
import { costTitle, fmtCost, fmtDate, fmtDuration, fmtTokens, sessionLabel, tokenSplitTitle } from "../format";
import { SessionLink } from "../SessionLink";
import { ArchivePathButton } from "./ArchivePathButton";
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
      <h1>{sessionLabel(s.title, s.id)}</h1>
      <div className="detail-meta">
        <span><b>{s.source_id}</b></span>
        <span className="path">{s.project_path}</span>
        {s.is_sidechain ? <span className="tag subagent">subagent</span> : null}
        {d.parent && (
          <span className="spawned-by">
            ↖ spawned by{" "}
            <SessionLink s={d.parent} />
            {d.parent.turn_seq != null ? ` · turn ${d.parent.turn_seq + 1}` : ""}
          </span>
        )}
        {/* Optional-chained like the cost below: an older server sends neither field (ADR-038). */}
        {d.continued_from && (
          <span className="spawned-by" data-tip="This session repeats that one's history; the earlier part is shown there.">
            ↖ continues <SessionLink s={d.continued_from} />
          </span>
        )}
        {d.continued_in?.length ? (
          <span className="spawned-by">
            ↘ continued in{" "}
            {d.continued_in.map((c, i) => (
              <span key={c.id}>
                {i > 0 && ", "}
                <SessionLink s={c} />
              </span>
            ))}
          </span>
        ) : null}
        <span>{d.turns.length} turns</span>
        <span>{s.event_count} events</span>
        <span data-tip={tokenSplitTitle(s.token_split)}>{fmtTokens(s.tokens)} tok</span>
        {/* Optional-chained: a newer SPA can be served by an older server that predates this field
            (the Versions block above warns about exactly that mismatch) — degrade, don't crash. */}
        <span data-tip={costTitle(s.unpriced_models)}>
          {fmtCost(s.cost)}
          {s.unpriced_models?.length ? <span className="warn-tag"> ⚠</span> : null}
        </span>
        {s.tool_call_count > 0 && (
          <span
            className={s.tool_failure_count > 0 ? "tool-err-stat" : "muted"}
            data-tip={
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
        <ArchivePathButton id={s.id} />
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
