import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type FileSummary, type Project } from "./api";
import { fmtDate } from "./format";
import { FilterSelect } from "./FilterSelect";
import { Pager } from "./Pager";
import { SortHeader, type SortDir } from "./sort";

const PAGE = 50;

type FileSortKey = "path" | "sessions" | "changes" | "last_ts";

interface Source {
  id: string;
  label: string;
  session_count: number;
}

/** A file's display path: project-relative when it lives under the project root, absolute otherwise
 * (out-of-project writes are real and must stay visibly absolute). Full path goes in the title attr. */
export function relPath(filePath: string, projectPath: string | null): string {
  if (projectPath && filePath.startsWith(projectPath.replace(/\/$/, "") + "/")) {
    return filePath.slice(projectPath.replace(/\/$/, "").length + 1);
  }
  return filePath;
}

/** Compact `+a −r` line-delta chip; em-dash when the row carries no line info at all. */
export function LinesDelta({ added, removed }: { added: number | null; removed: number | null }) {
  if (added == null && removed == null) return <span className="muted">—</span>;
  return (
    <span className="sub">
      {added != null && <span className="tag">+{added.toLocaleString()}</span>}
      {removed != null && <span className="tag">−{removed.toLocaleString()}</span>}
    </span>
  );
}

/**
 * Files list (ADR-022) — every file touched by a session's Edit/Write tool calls, aggregated per
 * (project, file). Server-side sort + paging (the list can span thousands of files); filters mirror
 * the sessions list. Each row links to the file's provenance timeline.
 */
export default function FilesView() {
  const [params, setParams] = useSearchParams();
  const [sources, setSources] = useState<Source[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [data, setData] = useState<{ total: number; files: FileSummary[] }>({ total: 0, files: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [qInput, setQInput] = useState(params.get("q") ?? "");
  const offset = Number(params.get("offset") ?? 0);

  useEffect(() => {
    api<Source[]>("/sources").then(setSources).catch(() => {});
    api<Project[]>("/projects").then(setProjects).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    for (const k of ["source", "project", "q", "sort", "dir"]) {
      const v = params.get(k);
      if (v) qs.set(k, v);
    }
    qs.set("limit", String(PAGE));
    qs.set("offset", String(offset));
    api<{ total: number; files: FileSummary[] }>("/files?" + qs.toString())
      .then(setData)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [params, offset]);

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

  // Sort is server-side (whole list, not just the page) and lives in the URL, like the sessions list.
  const sortKey = (params.get("sort") ?? "last_ts") as FileSortKey;
  const sortDir = (params.get("dir") === "asc" ? "asc" : "desc") as SortDir;
  function onSort(key: FileSortKey, defaultDir: SortDir) {
    const nextDir = sortKey === key ? (sortDir === "asc" ? "desc" : "asc") : defaultDir;
    const next = new URLSearchParams(params);
    next.set("sort", key);
    next.set("dir", nextDir);
    next.delete("offset");
    setParams(next);
  }

  const page = Math.floor(offset / PAGE) + 1;
  const pages = Math.max(1, Math.ceil(data.total / PAGE));
  const filtered = !!(params.get("q") || params.get("source") || params.get("project"));

  return (
    <div>
      <h1 className="sr-only">Files</h1>
      <div className="filters">
        <form onSubmit={submitSearch} className="search" role="search">
          <input
            type="search"
            aria-label="Search files by path"
            placeholder="Search file paths…"
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
      ) : data.files.length === 0 ? (
        <div className="muted pad" role="status">
          {filtered ? "No files match the filter." : "No file changes ingested yet — run agent-lens refresh (or ingest) first."}
        </div>
      ) : (
        <table className="sessions">
          <thead>
            <tr>
              <SortHeader label="File" sortKey="path" active={sortKey} dir={sortDir} onSort={onSort} defaultDir="asc" />
              <th>Project</th>
              <SortHeader label="Sessions" sortKey="sessions" active={sortKey} dir={sortDir} onSort={onSort} className="num" />
              <SortHeader label="Changes" sortKey="changes" active={sortKey} dir={sortDir} onSort={onSort} className="num" />
              <th className="num">+ / −</th>
              <SortHeader label="Last touched" sortKey="last_ts" active={sortKey} dir={sortDir} onSort={onSort} />
            </tr>
          </thead>
          <tbody>
            {data.files.map((f) => (
              <tr key={(f.project_id ?? "") + "\0" + f.file_path}>
                <td>
                  <Link
                    to={`/file?path=${encodeURIComponent(f.file_path)}${f.project_id ? `&project=${encodeURIComponent(f.project_id)}` : ""}`}
                    className="title"
                    title={f.file_path}
                  >
                    {relPath(f.file_path, f.project_path)}
                  </Link>
                </td>
                <td>{f.project_path ? <span className="tag" title={f.project_path}>{f.project_path.replace(/^.*\//, "")}</span> : <span className="muted">—</span>}</td>
                <td className="num">{f.sessions.toLocaleString()}</td>
                <td className="num">{f.changes.toLocaleString()}</td>
                <td className="num"><LinesDelta added={f.lines_added} removed={f.lines_removed} /></td>
                <td>{fmtDate(f.last_ts)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!loading && data.total > 0 && (
        <Pager page={page} pages={pages} total={data.total} unit="files" onPage={(p) => setParam("offset", String((p - 1) * PAGE))} />
      )}

      <p className="muted pad">
        Tracked from Edit/Write tool calls — changes made via shell commands or outside sessions aren’t captured.
      </p>
    </div>
  );
}
