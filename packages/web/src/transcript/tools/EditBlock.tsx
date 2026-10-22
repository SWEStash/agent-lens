import type { ToolCall } from "../../api";
import { ToolShell } from "./ToolShell";
import { splitPath, type EditView } from "../parse";

const EDIT_ICON: Record<string, string> = { Edit: "✏️", MultiEdit: "✏️", Write: "📄" };

const DIFF_MAX_LINES = 400;

/** Render an Edit / MultiEdit / Write tool call as a colored +/- diff (unchanged lines shown as muted
 * context) instead of a raw JSON blob: the file basename + path and a `+adds −dels` stat in the header,
 * one diff block per edit (capped, with a spill note), the result, and the raw input JSON one click
 * away. The container and result come from ToolShell. */
export function EditBlock({ t, edit }: { t: ToolCall; edit: EditView }) {
  const { dir, base } = splitPath(edit.file_path);
  return (
    <ToolShell
      t={t}
      name={`${EDIT_ICON[edit.kind] ?? "✏️"} ${edit.kind}`}
      head={() => (
        <>
          <span className="edit-path">
            <span className="base">{base}</span>
            {dir && <span className="dir">{dir.replace(/\/$/, "")}</span>}
          </span>
          <span className="diff-stat">
            {edit.adds > 0 && <span className="add">+{edit.adds}</span>}
            {edit.dels > 0 && <span className="del">−{edit.dels}</span>}
          </span>
        </>
      )}
      result="shell"
      rawJson
    >
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
    </ToolShell>
  );
}
