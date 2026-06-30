import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Project, type SkillSummary } from "./api";
import { fmtDate } from "./format";

interface Source {
  id: string;
  label: string;
  session_count: number;
}

/**
 * Skills list — every fired skill (grouped by name), filterable like the sessions list (name search,
 * source, project). Each row links to the skill's detail page. Counts come from GET /api/skills.
 */
export default function SkillsView() {
  const [params, setParams] = useSearchParams();
  const [sources, setSources] = useState<Source[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [qInput, setQInput] = useState(params.get("q") ?? "");

  useEffect(() => {
    api<Source[]>("/sources").then(setSources).catch(() => {});
    api<Project[]>("/projects").then(setProjects).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    for (const k of ["source", "project", "q"]) {
      const v = params.get(k);
      if (v) qs.set(k, v);
    }
    const s = qs.toString() ? "?" + qs.toString() : "";
    api<SkillSummary[]>("/skills" + s)
      .then(setSkills)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [params]);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    setParam("q", qInput.trim());
  }

  return (
    <div>
      <h1 className="sr-only">Skills</h1>
      <div className="filters">
        <form onSubmit={submitSearch} className="search" role="search">
          <input
            type="search"
            aria-label="Search skills by name"
            placeholder="Search skill names…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
          />
          <button type="submit">Search</button>
          {params.get("q") && (
            <button type="button" className="ghost" onClick={() => (setQInput(""), setParam("q", ""))}>
              clear
            </button>
          )}
        </form>
        {/* Source/project filters scope the list to skills fired in matching sessions. No "(count)"
            suffix here: the /sources and /projects endpoints report SESSION counts, which are
            unrelated to skills and only confuse on this page. */}
        <select aria-label="Filter by source" value={params.get("source") ?? ""} onChange={(e) => setParam("source", e.target.value)}>
          <option value="">all sources</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <select aria-label="Filter by project" value={params.get("project") ?? ""} onChange={(e) => setParam("project", e.target.value)}>
          <option value="">all projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.path.replace(/^.*\//, "")}
            </option>
          ))}
        </select>
      </div>

      {error && <div className="error" role="alert">{error}</div>}
      {loading ? (
        <div className="muted pad" role="status" aria-live="polite">Loading…</div>
      ) : skills.length === 0 ? (
        <div className="muted pad" role="status">No skills fired match.</div>
      ) : (
        <table className="sessions">
          <thead>
            <tr>
              <th>Skill</th>
              <th className="num">Fired</th>
              <th className="num">Versions</th>
              <th>Sources</th>
              <th>Last fired</th>
            </tr>
          </thead>
          <tbody>
            {skills.map((s) => (
              <tr key={s.name}>
                <td>
                  <Link to={`/skill/${encodeURIComponent(s.name)}`} className="title">
                    {s.name}
                  </Link>
                </td>
                <td className="num">{s.call_count.toLocaleString()}</td>
                <td className="num" title={`${s.version_count} distinct captured ${s.version_count === 1 ? "version" : "versions"}`}>
                  {s.version_count || <span className="muted">—</span>}
                </td>
                <td>
                  <span className="sub">
                    {s.sources.map((src) => (
                      <span key={src} className="tag">
                        {src}
                      </span>
                    ))}
                  </span>
                </td>
                <td>{fmtDate(s.last_fired)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
