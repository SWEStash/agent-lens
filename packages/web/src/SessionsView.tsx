import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Project, type SessionSummary } from "./api";
import { fmtCost, fmtDate, fmtDuration, fmtTokens, shortModel, tokenSplitTitle } from "./format";
import { FilterSelect } from "./FilterSelect";
import { Pager } from "./Pager";
import { SortHeader, type SortDir } from "./sort";

type SessionSortKey = "title" | "turns" | "tokens" | "cost" | "duration" | "started";

interface Source {
  id: string;
  label: string;
  session_count: number;
}

const PAGE = 50;

export default function SessionsView() {
  const [params, setParams] = useSearchParams();
  const [sources, setSources] = useState<Source[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [data, setData] = useState<{ total: number; sessions: SessionSummary[] }>({ total: 0, sessions: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [qInput, setQInput] = useState(params.get("q") ?? "");

  const offset = Number(params.get("offset") ?? 0);

  useEffect(() => {
    api<Source[]>("/sources").then(setSources).catch(() => {});
    api<Project[]>("/projects").then(setProjects).catch(() => {});
    api<string[]>("/models").then(setModels).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    for (const k of ["source", "project", "model", "q", "sort", "dir"]) {
      const v = params.get(k);
      if (v) qs.set(k, v);
    }
    // Default to main sessions only: subagents share their parent's slug, so listing them flat made
    // one task look like several "replicated" rows. They stay reachable via the filter and are nested
    // under their parent in the session detail view.
    qs.set("kind", params.get("kind") || "main");
    qs.set("limit", String(PAGE));
    qs.set("offset", String(offset));
    api<{ total: number; sessions: SessionSummary[] }>("/sessions?" + qs.toString())
      .then(setData)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [params]);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    // Changing a filter resets to page 1, but paging through offset must keep the value just set.
    if (key !== "offset") next.delete("offset");
    setParams(next);
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    setParam("q", qInput.trim());
  }

  // Sort is server-side (whole list, not just the page) and lives in the URL. Clicking the active
  // column flips direction; a new column adopts its default direction. Changing sort resets to page 1.
  const sortKey = (params.get("sort") ?? "started") as SessionSortKey;
  const sortDir = (params.get("dir") === "asc" ? "asc" : "desc") as SortDir;
  function onSort(key: SessionSortKey, defaultDir: SortDir) {
    const nextDir = sortKey === key ? (sortDir === "asc" ? "desc" : "asc") : defaultDir;
    const next = new URLSearchParams(params);
    next.set("sort", key);
    next.set("dir", nextDir);
    next.delete("offset");
    setParams(next);
  }

  const page = Math.floor(offset / PAGE) + 1;
  const pages = Math.max(1, Math.ceil(data.total / PAGE));

  return (
    <div>
      <h1 className="sr-only">Sessions</h1>
      <div className="filters">
        <form onSubmit={submitSearch} className="search" role="search">
          <input
            type="search"
            aria-label="Search session names, projects and transcripts"
            placeholder="Search names, projects & transcripts…"
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
        <select aria-label="Filter by source" value={params.get("source") ?? ""} onChange={(e) => setParam("source", e.target.value)}>
          <option value="">all sources</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label} ({s.session_count})
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
            ...projects.map((p) => ({ value: p.id, label: `${p.path.replace(/^.*\//, "")} (${p.session_count})` })),
          ]}
        />
        <select aria-label="Filter by model" value={params.get("model") ?? ""} onChange={(e) => setParam("model", e.target.value)}>
          <option value="">all models</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {shortModel(m)}
            </option>
          ))}
        </select>
        <select aria-label="Filter by kind" value={params.get("kind") || "main"} onChange={(e) => setParam("kind", e.target.value)}>
          <option value="main">main only</option>
          <option value="all">main + subagents</option>
          <option value="subagent">subagents only</option>
        </select>
      </div>

      {error && <div className="error" role="alert">{error}</div>}
      {loading ? (
        <div className="muted pad" role="status" aria-live="polite">Loading…</div>
      ) : data.sessions.length === 0 ? (
        <div className="muted pad" role="status">No sessions match.</div>
      ) : (
        <table className="sessions">
          <thead>
            <tr>
              <SortHeader label="Session" sortKey="title" active={sortKey} dir={sortDir} onSort={onSort} defaultDir="asc" />
              <th>Source</th>
              <th>Project</th>
              <SortHeader label="Turns" sortKey="turns" active={sortKey} dir={sortDir} onSort={onSort} className="num" />
              <SortHeader label="Tokens" sortKey="tokens" active={sortKey} dir={sortDir} onSort={onSort} className="num" />
              <SortHeader label="Cost" sortKey="cost" active={sortKey} dir={sortDir} onSort={onSort} className="num" />
              <SortHeader label="Duration" sortKey="duration" active={sortKey} dir={sortDir} onSort={onSort} className="num" />
              <SortHeader label="Started" sortKey="started" active={sortKey} dir={sortDir} onSort={onSort} />
            </tr>
          </thead>
          <tbody>
            {data.sessions.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link to={`/session/${s.id}`} className="title">
                    {s.title || <span className="muted">{s.id.slice(0, 12)}</span>}
                  </Link>
                  <div className="sub">
                    {s.is_sidechain ? <span className="tag subagent">subagent</span> : null}
                    {(s.models ?? "").split(",").filter(Boolean).slice(0, 3).map((m) => (
                      <span key={m} className="tag">
                        {shortModel(m)}
                      </span>
                    ))}
                  </div>
                </td>
                <td>{s.source_id}</td>
                <td className="path">{s.project_path?.replace(/^.*\//, "") ?? "—"}</td>
                <td className="num">{s.turn_count}</td>
                <td className="num" title={tokenSplitTitle(s.token_split)}>{fmtTokens(s.tokens)}</td>
                <td className="num" title="Estimated at API list prices (cache-aware)">{fmtCost(s.cost)}</td>
                <td className="num">{fmtDuration(s.duration_ms)}</td>
                <td>{fmtDate(s.started_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Pager page={page} pages={pages} total={data.total} unit="sessions" onPage={(p) => setParam("offset", String((p - 1) * PAGE))} />
    </div>
  );
}
