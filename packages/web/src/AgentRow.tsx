/** One spawned-agent row, linking to its full transcript. Shared by the session page (subagents
 * fanned out by a turn) and the workflow page (agents fanned out by a run), which list the same
 * thing. */
import { Link } from "react-router-dom";
import { fmtCost, fmtDuration, fmtTokens, shortModel } from "./format";

/** The fields both `SessionChild` and `WorkflowAgent` carry. `duration_ms` is workflow-only (the
 * session payload doesn't compute it), so the row simply omits it when absent. */
export interface AgentRowData {
  id: string;
  title: string | null;
  /** From the agent's meta sidecar (session_meta) — a human description beats the derived title. */
  agent_description: string | null;
  agent_type: string | null;
  spawn_depth: number | null;
  models: string | null;
  tokens: number;
  cost: number;
  duration_ms?: number | null;
}

export function AgentRow({ a }: { a: AgentRowData }) {
  const title = a.agent_description || a.title || a.id.slice(0, 12);
  const models = (a.models ?? "").split(",").filter(Boolean).map(shortModel).join(", ");
  return (
    <li>
      <Link to={`/session/${a.id}`}>{title}</Link>
      {a.agent_type && <span className="tag subagent meta-type">{a.agent_type}</span>}
      {a.spawn_depth != null && a.spawn_depth > 1 && (
        <span className="tag meta-depth" title={`nested ${a.spawn_depth} levels deep`}>
          ↳{a.spawn_depth}
        </span>
      )}
      <span className="muted">
        {" "}
        · {models || "—"} · {fmtTokens(a.tokens)} tok · {fmtCost(a.cost)}
        {a.duration_ms != null ? ` · ${fmtDuration(a.duration_ms)}` : ""}
      </span>
    </li>
  );
}
