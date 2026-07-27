import { useId, useState } from "react";
import { Link } from "react-router-dom";
import type { ToolCall } from "../../api";
import { fmtDuration } from "../../format";
import { prettyJson } from "../../jsonish";
import CopyButton from "../../CopyButton";

export function ToolChip({ t }: { t: ToolCall }) {
  const [open, setOpen] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const bodyId = useId();
  const label = t.skill_name
    ? `Skill · ${t.skill_name}`
    : t.tool_name === "Workflow" && t.workflow_name
      ? `Workflow · ${t.workflow_name}`
      : t.agent_type
        ? `${t.tool_name} → ${t.agent_type}`
        : t.tool_name;
  return (
    <div className={"tool " + (t.status === "error" ? "tool-err" : "")}>
      <button className="tool-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
        <span className="tool-name">🔧 {label}</span>
        {t.status && <span className="tool-status">{t.status}</span>}
        {t.total_duration_ms ? <span className="muted">{fmtDuration(t.total_duration_ms)}</span> : null}
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {t.spawned_session_id && (
        <Link className="subagent-link small" to={`/session/${t.spawned_session_id}`}>
          view subagent transcript →
        </Link>
      )}
      {t.workflow_run_id && (
        <Link className="subagent-link small" to={`/workflow/${t.workflow_run_id}`}>
          🔀 launched {t.workflow_agent_count ?? 0} agent{t.workflow_agent_count === 1 ? "" : "s"} · <code>{t.workflow_run_id}</code> →
        </Link>
      )}
      {t.skill_name && (
        <Link
          className="subagent-link small"
          to={`/skill/${encodeURIComponent(t.skill_name)}${t.skill_id ? `?v=${t.skill_id}` : ""}`}
        >
          📖 view skill{t.skill_id ? " version" : ""} →
        </Link>
      )}
      {open && (
        <div className="tool-body" id={bodyId}>
          {t.input_json && t.input_json !== "{}" && (
            <div className="code-block">
              <CopyButton text={prettyJson(t.input_json)} className="copy-corner" title="Copy tool input JSON" />
              <pre className="code">{prettyJson(t.input_json)}</pre>
            </div>
          )}
          {t.result_summary && <div className="result">{t.result_summary}</div>}
          {t.full_result && (
            <div className="full-result">
              <button
                type="button"
                className="ghost small show-full"
                aria-expanded={showFull}
                onClick={() => setShowFull((s) => !s)}
              >
                {showFull ? "Hide" : "Show"} full result ({(t.full_result.bytes / 1024).toFixed(1)} KB)
              </button>
              {showFull && (
                <div className="code-block">
                  <CopyButton text={t.full_result.text} className="copy-corner" title="Copy full tool result" />
                  <pre className="code">{t.full_result.text}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
