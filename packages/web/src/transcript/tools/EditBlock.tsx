import { useId, useState } from "react";
import type { ToolCall } from "../../api";
import { fmtDuration } from "../../format";
import { prettyJson } from "../../jsonish";
import CopyButton from "../../CopyButton";
import { splitPath, type EditView } from "../parse";

const EDIT_ICON: Record<string, string> = { Edit: "✏️", MultiEdit: "✏️", Write: "📄" };

const DIFF_MAX_LINES = 400;

/** Render an Edit / MultiEdit / Write tool call as a colored +/- diff (unchanged lines shown as muted
 * context) instead of a raw JSON blob: the file basename + path and a `+adds −dels` stat in the header,
 * one diff block per edit (capped, with a spill note), the result, and the raw input JSON one click
 * away. Mirrors BashBlock's collapsible container so hide-tools/collapse behaviour is unchanged. */
export function EditBlock({ t, edit }: { t: ToolCall; edit: EditView }) {
  const [open, setOpen] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [raw, setRaw] = useState(false);
  const bodyId = useId();
  const rawId = useId();
  const { dir, base } = splitPath(edit.file_path);
  return (
    <div className={"tool " + (t.status === "error" ? "tool-err" : "")}>
      <button className="tool-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
        <span className="tool-name">
          {EDIT_ICON[edit.kind] ?? "✏️"} {edit.kind}
        </span>
        <span className="edit-path">
          <span className="base">{base}</span>
          {dir && <span className="dir">{dir.replace(/\/$/, "")}</span>}
        </span>
        <span className="diff-stat">
          {edit.adds > 0 && <span className="add">+{edit.adds}</span>}
          {edit.dels > 0 && <span className="del">−{edit.dels}</span>}
        </span>
        {t.status && <span className="tool-status">{t.status}</span>}
        {t.total_duration_ms ? <span className="muted">{fmtDuration(t.total_duration_ms)}</span> : null}
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tool-body" id={bodyId}>
          {edit.hunks.map((hunk, hi) => (
            <div key={hi} className="diff">
              {edit.hunks.length > 1 && <div className="diff-hunk-sep">edit {hi + 1}</div>}
              {hunk.slice(0, DIFF_MAX_LINES).map((l, i) => (
                <div key={i} className={"diff-line " + l.type}>
                  <span className="diff-sign" aria-hidden="true">
                    {l.type === "add" ? "+" : l.type === "del" ? "−" : " "}
                  </span>
                  <span className="diff-text">{l.text === "" ? " " : l.text}</span>
                </div>
              ))}
              {hunk.length > DIFF_MAX_LINES && (
                <div className="diff-more">… {hunk.length - DIFF_MAX_LINES} more lines — View raw JSON for the rest</div>
              )}
            </div>
          ))}
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
