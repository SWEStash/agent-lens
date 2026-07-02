import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Project, type SkillSummary } from "./api";
import { fmtDate } from "./format";
import { FilterSelect } from "./FilterSelect";
import { Pager } from "./Pager";
import { SortHeader, sortRows, useSort } from "./sort";

const PAGE = 50;

type SkillSortKey = "name" | "fired" | "last_fired";
const SKILL_SORT: Record<SkillSortKey, (s: SkillSummary) => string | number | null> = {
  name: (s) => s.name,
  fired: (s) => s.call_count,
  last_fired: (s) => s.last_fired, // ISO 8601 strings sort chronologically as text
};

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
  // Sorting is client-side: the /skills endpoint returns the whole filtered list, so a sort here spans
  // every skill, not just a page. Default mirrors the server order (most-fired).
  const { sort, toggle } = useSort<SkillSortKey>("fired", "desc");
  // Pagination is client-side too: sort the whole list, then slice the visible page.
  const [page, setPage] = useState(1);

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

  // A filter or sort change returns to page 1 (mirrors the sessions list).
  useEffect(() => setPage(1), [params, sort.key, sort.dir]);

  const sorted = useMemo(() => sortRows(skills, SKILL_SORT[sort.key], sort.dir), [skills, sort.key, sort.dir]);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE));
  const clampedPage = Math.min(page, pages);
  const pageRows = sorted.slice((clampedPage - 1) * PAGE, clampedPage * PAGE);

  return (
    <div>
      <h1 className="sr-only">Skills</h1>
      <div className="filters">
        <form onSubmit={submitSearch} className="search" role="search">
          <input
            type="search"
            aria-label="Search skills by name and body"
            placeholder="Search skill names & bodies…"
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
        <FilterSelect
          ariaLabel="Filter by project"
          searchPlaceholder="Find project…"
          value={params.get("project") ?? ""}
          onChange={(v) => setParam("project", v)}
          options={[
            { value: "", label: "all projects" },
            ...projects.map((p) => ({ value: p.id, label: p.path.replace(/^.*\//, "") })),
          ]}
        />
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
              <SortHeader label="Skill" sortKey="name" active={sort.key} dir={sort.dir} onSort={toggle} defaultDir="asc" />
              <SortHeader label="Fired" sortKey="fired" active={sort.key} dir={sort.dir} onSort={toggle} className="num" />
              <th className="num">Versions</th>
              <th>Sources</th>
              <SortHeader label="Last fired" sortKey="last_fired" active={sort.key} dir={sort.dir} onSort={toggle} />
            </tr>
          </thead>
          <tbody>
            {pageRows.map((s) => (
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

      {!loading && sorted.length > 0 && (
        <Pager page={clampedPage} pages={pages} total={sorted.length} unit="skills" onPage={setPage} />
      )}
    </div>
  );
}
