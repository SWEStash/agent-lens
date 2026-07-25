import { Link } from "react-router-dom";
import type { ToolCall } from "../../api";

/** A Workflow launch, rendered minimally in the transcript: the run name/status, the launch ack, and
 * a link into the workflow detail page — where the full launch payload (task list, script, raw JSON)
 * is rendered. The transcript deliberately stays compact; the big fan-out belongs on the workflow
 * page, not inline. Like Plans/Q&A it's a significant action, so it always shows. */
export function WorkflowLaunchBlock({ t }: { t: ToolCall }) {
  const label = t.workflow_name ? `Workflow · ${t.workflow_name}` : "Workflow";
  return (
    <div className="tool launch-tool">
      <div className="launch-tool-head">
        <span className="tool-name">🔀 {label}</span>
        {t.status && <span className="tool-status">{t.status}</span>}
      </div>
      {t.workflow_run_id && (
        <Link className="subagent-link small" to={`/workflow/${t.workflow_run_id}`}>
          🔀 launched {t.workflow_agent_count ?? 0} agent{t.workflow_agent_count === 1 ? "" : "s"} · <code>{t.workflow_run_id}</code> →
        </Link>
      )}
      {t.result_summary && <div className="result">{t.result_summary}</div>}
    </div>
  );
}
