import { Fragment } from "react";
import { Link } from "react-router-dom";
import type { FileChangeRow } from "../api";
import { buildFileTree, type FileTreeNode } from "./tree";

/** Render a tree node as indented table rows: directory rows span the table; file rows keep the
 * jump link, change summary, and history link. Dirs first, then files, both alphabetical. */
function FileTreeRows({ node, depth }: { node: FileTreeNode; depth: number }) {
  const indent = { paddingLeft: `${0.4 + depth * 1.1}rem` };
  return (
    <>
      {[...node.dirs.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, child]) => (
          <Fragment key={name}>
            <tr>
              <td colSpan={3} style={indent}>
                <span className="muted">📁 {name}/</span>
              </td>
            </tr>
            <FileTreeRows node={child} depth={depth + 1} />
          </Fragment>
        ))}
      {[...node.files]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((f) => {
          const first = f.list.find((c) => c.event_uuid);
          const added = f.list.reduce((a, c) => a + (c.lines_added ?? 0), 0);
          const removed = f.list.reduce((a, c) => a + (c.lines_removed ?? 0), 0);
          return (
            <tr key={f.path}>
              <td style={indent}>
                {first?.event_uuid ? (
                  <a href={`#ev-${first.event_uuid}`} className="title" title={f.path + " — jump to the first change"}>
                    {f.name}
                  </a>
                ) : (
                  <span title={f.path}>{f.name}</span>
                )}
              </td>
              <td className="num">
                {f.list.length}× <span className="muted">(+{added} −{removed})</span>
              </td>
              <td>
                <Link className="subagent-link small" to={`/file?path=${encodeURIComponent(f.path)}`}>
                  history →
                </Link>
              </td>
            </tr>
          );
        })}
    </>
  );
}

/**
 * Touches of one file within one session at which it is worth saying so out loud.
 *
 * From the corpus histogram: pairs at 7+ touches are a small minority of (session, file) pairs but
 * carry over a quarter of every edit made. It is a threshold for surfacing a list, NOT a quality
 * signal — rework was tested against session cost in both directions and the relationship is flat.
 */
const REWORK_TOUCHES = 7;
/** Most-reworked files named inline before the count gives way to "and N more". */
const REWORK_NAMED = 4;

/** "Files changed" roll-up in the transcript header (ADR-022): the session's derived Edit/Write file
 * modifications, grouped per file and rendered as a compressed directory tree. Collapsed by default
 * (native <details>, like the subagent run groups); each file jumps to its first change's transcript
 * event and links to its provenance page. Rendered only when the session changed at least one file. */
export function FilesChangedPanel({ changes, projectPath }: { changes: FileChangeRow[]; projectPath: string | null }) {
  const byFile = new Map<string, FileChangeRow[]>();
  for (const c of changes) (byFile.get(c.file_path) ?? byFile.set(c.file_path, []).get(c.file_path))!.push(c);
  const rel = (p: string) =>
    projectPath && p.startsWith(projectPath.replace(/\/$/, "") + "/") ? p.slice(projectPath.replace(/\/$/, "").length + 1) : p;
  const tree = buildFileTree([...byFile.entries()].map(([path, list]) => ({ display: rel(path), path, list })));
  // A count and a list, never a score. It answers "did this session keep going back to the same
  // file", which the per-file rows already contain but bury once a session touches thirty of them.
  const reworked = [...byFile.entries()]
    .filter(([, list]) => list.length >= REWORK_TOUCHES)
    .sort((a, b) => b[1].length - a[1].length);
  return (
    <details className="wf-run files-changed">
      <summary>
        📄 {byFile.size} {byFile.size === 1 ? "file" : "files"} changed · {changes.length}{" "}
        {changes.length === 1 ? "edit" : "edits"}
        {reworked.length > 0 && (
          <span className="muted"> · {reworked.length} edited {REWORK_TOUCHES}+ times</span>
        )}
      </summary>
      {reworked.length > 0 && (
        <p className="muted files-rework">
          Most reworked:{" "}
          {reworked.slice(0, REWORK_NAMED).map(([path, list], i) => (
            <Fragment key={path}>
              {i > 0 && ", "}
              <span title={path}>
                {rel(path).split("/").pop()} ({list.length}×)
              </span>
            </Fragment>
          ))}
          {reworked.length > REWORK_NAMED && `, and ${reworked.length - REWORK_NAMED} more`}
        </p>
      )}
      <table className="sessions">
        <tbody>
          <FileTreeRows node={tree} depth={0} />
        </tbody>
      </table>
    </details>
  );
}
