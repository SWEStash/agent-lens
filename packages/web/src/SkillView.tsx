import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type SkillDetail } from "./api";
import { fmtDate } from "./format";

function fmtBytes(n: number | null): string {
  if (!n || n < 0) return "—";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

/** Short, stable label for a version: its hash prefix + last-seen date. */
function versionLabel(id: string, lastSeen: string | null): string {
  return `${id.slice(0, 8)} · ${fmtDate(lastSeen)}`;
}

/**
 * Skill detail — all data for one skill (by name). A version dropdown switches between captured
 * content versions (default = most recent); the body and the sessions list below are both scoped to
 * the selected version. Deep link `/skill/:name?v=<id>` preselects a version (used by the session
 * transcript and the dashboard). Served by GET /api/skills/:name.
 */
export default function SkillView() {
  const { name = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setData(null);
    api<SkillDetail>("/skills/" + encodeURIComponent(name))
      .then(setData)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [name]);

  // Selected version: the ?v= one if it exists, else the most recent (versions[0]).
  const selected = useMemo(() => {
    if (!data?.versions.length) return null;
    const v = params.get("v");
    return data.versions.find((x) => x.id === v) ?? data.versions[0];
  }, [data, params]);

  const sessionsForVersion = useMemo(
    () => (data && selected ? data.sessions.filter((s) => s.version_id === selected.id) : []),
    [data, selected],
  );
  const unversionedFires = useMemo(
    () => (data ? data.sessions.filter((s) => !s.version_id).length : 0),
    [data],
  );

  function pickVersion(id: string) {
    const next = new URLSearchParams(params);
    next.set("v", id);
    setParams(next);
  }

  if (loading) return <div className="muted pad" role="status" aria-live="polite">Loading…</div>;
  if (error) return <div className="error" role="alert">{error}</div>;
  if (!data) return <div className="muted pad">Not found.</div>;

  return (
    <div className="skill-view">
      <Link to="/skills" className="back">
        ← all skills
      </Link>
      <header className="skill-head">
        <h1>📖 {data.name}</h1>
        <div className="skill-head-meta muted">
          {data.call_count.toLocaleString()} firing{data.call_count === 1 ? "" : "s"} ·{" "}
          {data.versions.length} version{data.versions.length === 1 ? "" : "s"}
          {selected?.summary ? <> · {selected.summary}</> : null}
        </div>
      </header>

      {data.versions.length === 0 ? (
        <div className="empty">
          This skill fired {data.call_count.toLocaleString()} time(s) but no SKILL.md body was captured in the
          transcripts, so there is no version content to show.
        </div>
      ) : (
        <>
          <div className="skill-version-bar">
            <label className="ctl">
              version{" "}
              <select aria-label="Skill version" value={selected?.id ?? ""} onChange={(e) => pickVersion(e.target.value)}>
                {data.versions.map((v, i) => (
                  <option key={v.id} value={v.id}>
                    {versionLabel(v.id, v.last_seen)} · {v.call_count} fire{v.call_count === 1 ? "" : "s"}
                    {i === 0 ? " (latest)" : ""}
                  </option>
                ))}
              </select>
            </label>
            {selected && (
              <span className="muted small">
                first seen {fmtDate(selected.first_seen)} · last seen {fmtDate(selected.last_seen)} ·{" "}
                {fmtBytes(selected.body_bytes)}
              </span>
            )}
          </div>

          {selected && (
            <div className="cards skill-cards">
              <div className="card skill-body-card">
                <div className="card-head">
                  <h3>Skill body</h3>
                  <span className="card-hint">version {selected.id.slice(0, 8)}</span>
                </div>
                <div className="md skill-body">
                  <Markdown remarkPlugins={[remarkGfm]}>{selected.body}</Markdown>
                </div>
              </div>

              <div className="card skill-sessions-card">
                <div className="card-head">
                  <h3>Sessions that fired this version</h3>
                  <span className="card-hint">{sessionsForVersion.length}</span>
                </div>
                {sessionsForVersion.length === 0 ? (
                  <div className="empty">No sessions fired this version.</div>
                ) : (
                  <table className="sessions">
                    <thead>
                      <tr>
                        <th>Session</th>
                        <th>Source</th>
                        <th>Project</th>
                        <th className="num">Fires</th>
                        <th>When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sessionsForVersion.map((s) => (
                        <tr key={s.id}>
                          <td>
                            <Link to={`/session/${s.id}`} className="title">
                              {s.title || <span className="muted">{s.id.slice(0, 12)}</span>}
                            </Link>
                          </td>
                          <td>{s.source_id}</td>
                          <td className="path">{s.project_path?.replace(/^.*\//, "") ?? "—"}</td>
                          <td className="num">{s.fire_count}</td>
                          <td>{fmtDate(s.fired_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {unversionedFires > 0 && (
                  <div className="muted small pad">
                    {unversionedFires} firing(s) had no captured body and aren’t attributed to a version.
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
