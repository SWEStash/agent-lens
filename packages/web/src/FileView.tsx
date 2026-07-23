import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type FileTimeline } from "./api";
import { fmtDate } from "./format";
import { LinesDelta, relPath } from "./FilesView";

/**
 * File provenance timeline (ADR-022) — every session (and turn) whose Edit/Write tool calls touched
 * this file, newest-changing session first. Each change deep-links to its tool call's transcript
 * event (#ev-<uuid>), which the session page scrolls to, expands, and flashes. The file path travels
 * as a query param (it contains slashes).
 */
export default function FileView() {
  const [params] = useSearchParams();
  const path = params.get("path") ?? "";
  const project = params.get("project") ?? "";
  const [data, setData] = useState<FileTimeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ path });
    if (project) qs.set("project", project);
    api<FileTimeline>("/file?" + qs.toString())
      .then(setData)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [path, project]);

  if (loading) return <div className="muted pad" role="status" aria-live="polite">Loading…</div>;
  if (error) return <div className="error" role="alert">{error}</div>;
  if (!path || !data) return <div className="muted pad">Not found.</div>;

  return (
    <div className="file-view">
      <Link to="/files" className="back">
        ← all files
      </Link>
      <header className="skill-head">
        <h1>📄 {relPath(data.file_path, data.project_path)}</h1>
        <div className="skill-head-meta muted">
          <span title={data.file_path}>{data.file_path}</span>
          {data.project_path ? <> · in {data.project_path.replace(/^.*\//, "")}</> : null}
        </div>
      </header>

      <div className="kpis">
        <div className="kpi">
          <div className="kpi-label">sessions</div>
          <div className="kpi-value">{data.sessions_count.toLocaleString()}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">changes</div>
          <div className="kpi-value">{data.changes_count.toLocaleString()}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">lines + / −</div>
          <div className="kpi-value">
            +{data.lines_added.toLocaleString()} −{data.lines_removed.toLocaleString()}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">first · last touched</div>
          <div className="kpi-value kpi-sub">
            {fmtDate(data.first_ts)} · {fmtDate(data.last_ts)}
          </div>
        </div>
      </div>

      {data.sessions.map((s) => (
        <div className="card" key={s.session_id}>
          <div className="card-head">
            <h3>
              <Link to={`/session/${s.session_id}`} className="title">
                {s.title || <span className="muted">{s.session_id.slice(0, 12)}</span>}
              </Link>
            </h3>
            <span className="card-hint">
              {s.category && <span className={`tag cat-${s.category}`}>{s.category}</span>}
              {s.source_id && <span className="tag">{s.source_id}</span>} {fmtDate(s.started_at)}
            </span>
          </div>
          <table className="sessions">
            <thead>
              <tr>
                <th>Turn</th>
                <th>Tool</th>
                <th className="num">+ / −</th>
                <th>Prompt</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {s.changes.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.event_uuid ? (
                      <Link to={`/session/${s.session_id}#ev-${c.event_uuid}`} className="title" title="Jump to this change in the transcript">
                        turn {c.turn_seq != null ? c.turn_seq + 1 : "?"}
                      </Link>
                    ) : (
                      <span className="muted">turn {c.turn_seq != null ? c.turn_seq + 1 : "?"}</span>
                    )}
                  </td>
                  <td>
                    <span className="tag">{c.tool_name}</span>
                  </td>
                  <td className="num">
                    <LinesDelta added={c.lines_added} removed={c.lines_removed} />
                  </td>
                  <td className="muted" title={c.prompt_preview ?? undefined}>
                    {c.prompt_preview ? (c.prompt_preview.length > 80 ? c.prompt_preview.slice(0, 79) + "…" : c.prompt_preview) : "—"}
                  </td>
                  <td>{fmtDate(c.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <p className="muted pad">
        Tracked from Edit/Write tool calls — changes made via shell commands or outside sessions aren’t captured.
      </p>
    </div>
  );
}
