import { Link } from "react-router-dom";
import type { ToolCall } from "../../api";
import { prettyJson } from "../../jsonish";
import CopyButton from "../../CopyButton";
import { ToolShell } from "./ToolShell";
import { WorkflowRunLink } from "./WorkflowLaunchBlock";

export function ToolChip({ t }: { t: ToolCall }) {
  const label = t.skill_name
    ? `Skill · ${t.skill_name}`
    : t.tool_name === "Workflow" && t.workflow_name
      ? `Workflow · ${t.workflow_name}`
      : t.agent_type
        ? `${t.tool_name} → ${t.agent_type}`
        : t.tool_name;
  const links = (
    <>
      {t.spawned_session_id && (
        <Link className="subagent-link small" to={`/session/${t.spawned_session_id}`}>
          view subagent transcript →
        </Link>
      )}
      <WorkflowRunLink t={t} />
      {t.skill_name && (
        <Link
          className="subagent-link small"
          to={`/skill/${encodeURIComponent(t.skill_name)}${t.skill_id ? `?v=${t.skill_id}` : ""}`}
        >
          📖 view skill{t.skill_id ? " version" : ""} →
        </Link>
      )}
    </>
  );
  return (
    <ToolShell t={t} name={`🔧 ${label}`} links={links}>
      {t.input_json && t.input_json !== "{}" && (
        <div className="code-block">
          <CopyButton text={prettyJson(t.input_json)} className="copy-corner" title="Copy tool input JSON" />
          <pre className="code">{prettyJson(t.input_json)}</pre>
        </div>
      )}
    </ToolShell>
  );
}
