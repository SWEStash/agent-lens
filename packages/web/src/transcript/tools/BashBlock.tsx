import { useId, useState } from "react";
import type { ToolCall } from "../../api";
import { fmtDuration } from "../../format";
import { prettyJson } from "../../jsonish";
import CopyButton from "../../CopyButton";
import { splitShellCommand } from "../shell";
import type { BashInput } from "../parse";

/** Render a Bash tool call as a shell console: the description as a `#` caption beside the title (or, if
 * absent, a one-line command preview when collapsed), and when open a terminal-style command block with
 * a `$` prompt per logical command (heredoc bodies / continuations get no prompt), flag badges, the
 * command output, and the raw input JSON one click away. Mirrors ToolChip's collapsible container +
 * result rendering so hide-tools/collapse behaviour is unchanged. */
export function BashBlock({ t, bash }: { t: ToolCall; bash: BashInput }) {
  const [open, setOpen] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [raw, setRaw] = useState(false);
  const bodyId = useId();
  const rawId = useId();
  const preview = bash.command.split("\n")[0];
  const lines = splitShellCommand(bash.command);
  return (
    <div className={"tool " + (t.status === "error" ? "tool-err" : "")}>
      <button className="tool-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
        <span className="tool-name">🖥 Bash</span>
        {bash.description ? (
          <span className="bash-desc"># {bash.description}</span>
        ) : (
          !open && <span className="bash-preview">{preview}</span>
        )}
        {t.status && <span className="tool-status">{t.status}</span>}
        {t.total_duration_ms ? <span className="muted">{fmtDuration(t.total_duration_ms)}</span> : null}
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tool-body" id={bodyId}>
          <div className="shell code-block">
            <CopyButton text={bash.command} className="copy-corner" title="Copy command" />
            <pre className="shell-cmd">
              {lines.map((l, i) => (
                <span key={i}>
                  <span className={"shell-gutter" + (l.cont ? " cont" : "")} aria-hidden="true">
                    {l.cont ? "  " : "$ "}
                  </span>
                  {l.text}
                  {i < lines.length - 1 ? "\n" : ""}
                </span>
              ))}
            </pre>
          </div>
          {(bash.run_in_background || bash.restart || bash.timeout != null) && (
            <div className="bash-badges">
              {bash.run_in_background && <span className="bash-badge">background</span>}
              {bash.restart && <span className="bash-badge">restart</span>}
              {bash.timeout != null && <span className="bash-badge">timeout {Math.round(bash.timeout / 1000)}s</span>}
            </div>
          )}
          {t.result_summary && <pre className="shell-out">{t.result_summary}</pre>}
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
          <div className="launch-actions">
            <button className="ghost small" aria-expanded={raw} aria-controls={rawId} onClick={() => setRaw((r) => !r)}>
              {raw ? "Hide raw JSON ▴" : "View raw JSON ▾"}
            </button>
            <CopyButton text={prettyJson(t.input_json ?? "{}")} label="JSON" title="Copy raw tool input JSON" />
          </div>
          {raw && (
            <pre id={rawId} className="code">
              {prettyJson(t.input_json ?? "{}")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
