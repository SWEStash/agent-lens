import { Link } from "react-router-dom";
import type { SessionDetail } from "../api";
import { AgentRow } from "../AgentRow";

/** Spawned subagents grouped by what launched them: one collapsible group per Workflow run (named,
 * counted, linked to the launching turn) and one for Task/Agent spawns — instead of one flat,
 * unattributed list. A run can fan out to dozens of agents, so groups are collapsed by default. */
export function SubagentPanel({ d }: { d: SessionDetail }) {
  const runs = d.workflow_runs ?? [];
  const direct = d.children.filter((c) => !c.workflow_run_id);
  const grouped = runs.length > 0;
  return (
    <div className="subagents">
      <h2>Spawned subagents ({d.children.length})</h2>
      {runs.map((run) => {
        const kids = d.children.filter((c) => c.workflow_run_id === run.run_id);
        return (
          <details key={run.run_id} className="wf-run">
            <summary>
              <Link className="wf-run-name" to={`/workflow/${run.run_id}`} onClick={(e) => e.stopPropagation()}>
                🔀 {run.name || "workflow"} →
              </Link>
              {run.status && (
                <span className={"tag task-status task-status-" + run.status.toLowerCase()}>{run.status}</span>
              )}
              <span className="muted small">
                {kids.length} agent{kids.length === 1 ? "" : "s"}
                {run.turn_seq != null ? ` · turn ${run.turn_seq + 1}` : ""} · <code>{run.run_id}</code>
              </span>
            </summary>
            <ul>{kids.map((c) => <AgentRow key={c.id} a={c} />)}</ul>
          </details>
        );
      })}
      {direct.length > 0 &&
        (grouped ? (
          <details className="wf-run" open>
            <summary>
              <span className="wf-run-name">Task / Agent</span>
              <span className="muted small">{direct.length} subagent{direct.length === 1 ? "" : "s"}</span>
            </summary>
            <ul>{direct.map((c) => <AgentRow key={c.id} a={c} />)}</ul>
          </details>
        ) : (
          <ul>{direct.map((c) => <AgentRow key={c.id} a={c} />)}</ul>
        ))}
    </div>
  );
}
