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
  return (
    <details className="wf-run files-changed">
      <summary>
        📄 {byFile.size} {byFile.size === 1 ? "file" : "files"} changed · {changes.length}{" "}
        {changes.length === 1 ? "edit" : "edits"}
      </summary>
      <table className="sessions">
        <tbody>
          <FileTreeRows node={tree} depth={0} />
        </tbody>
      </table>
    </details>
  );
}
