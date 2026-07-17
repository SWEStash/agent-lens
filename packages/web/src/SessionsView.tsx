import { Fragment, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Project, type SessionSummary } from "./api";
import { fmtCost, fmtDate, fmtDuration, fmtTokens, shortModel, tokenSplitTitle } from "./format";
import { FilterSelect } from "./FilterSelect";
import { Pager } from "./Pager";
import { SortHeader, type SortDir } from "./sort";

type SessionSortKey = "title" | "turns" | "tokens" | "cost" | "duration" | "started" | "errors" | "security";

interface Source {
  id: string;
  label: string;
  session_count: number;
}

/** A sessions-table column. `toggleable` columns can be hidden via the "Columns" customizer and their
 * visibility persists in localStorage; non-toggleable ones (Session) always render. `sortKey` (when
 * set) makes the header a server-side sort control. Defined once, module-level, so the registry is the
 * single source of truth for both the header row and the body cells (they can't drift out of sync). */
interface ColumnDef {
  id: string;
  label: string;
  toggleable: boolean;
  defaultVisible: boolean;
  sortKey?: SessionSortKey;
  sortDefaultDir?: SortDir;
  thClassName?: string;
  cell: (s: SessionSummary) => React.ReactNode;
}

const COLUMNS: ColumnDef[] = [
  {
    id: "session",
    label: "Session",
    toggleable: false,
    defaultVisible: true,
    sortKey: "title",
    sortDefaultDir: "asc",
    cell: (s) => (
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
    ),
  },
  { id: "source", label: "Source", toggleable: true, defaultVisible: true, cell: (s) => <td>{s.source_id}</td> },
  {
    id: "project",
    label: "Project",
    toggleable: true,
    defaultVisible: true,
    cell: (s) => <td className="path">{s.project_path?.replace(/^.*\//, "") ?? "—"}</td>,
  },
  { id: "turns", label: "Turns", toggleable: true, defaultVisible: true, sortKey: "turns", thClassName: "num", cell: (s) => <td className="num">{s.turn_count}</td> },
  {
    id: "tokens",
    label: "Tokens",
    toggleable: true,
    defaultVisible: true,
    sortKey: "tokens",
    thClassName: "num",
    cell: (s) => <td className="num" title={tokenSplitTitle(s.token_split)}>{fmtTokens(s.tokens)}</td>,
  },
  {
    id: "security",
    label: "Security",
    toggleable: true,
    defaultVisible: true,
    sortKey: "security",
    thClassName: "num",
    cell: (s) => (
      <td className="num">
        {s.finding_count > 0 && s.worst_severity ? (
          // A colored dot conveys the highest severity ("how bad"); the number is the total finding
          // count ("how many"). Keeping them visually distinct avoids reading "critical 40" as "40
          // critical findings". The full meaning is in the aria-label/title for SR + hover.
          <span
            className="sec-count"
            aria-label={`${s.finding_count} finding${s.finding_count === 1 ? "" : "s"}, highest severity ${s.worst_severity}`}
            title={`${s.finding_count} finding${s.finding_count === 1 ? "" : "s"} · highest severity: ${s.worst_severity}`}
          >
            <span className={"sev-dot sev-" + s.worst_severity} aria-hidden="true" />
            {s.finding_count}
          </span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
    ),
  },
  {
    id: "errors",
    label: "Errors",
    toggleable: true,
    defaultVisible: true,
    sortKey: "errors",
    thClassName: "num",
    cell: (s) => (
      <td
        className="num"
        title={
          s.tool_call_count > 0
            ? `${s.tool_error_count}/${s.tool_call_count} tool calls returned an error (includes user-rejected/guardrail-blocked; see the session for the failure vs declined split)`
            : "no tool calls"
        }
      >
        {s.tool_error_count > 0 ? <span className="tool-err-stat">{s.tool_error_count}</span> : <span className="muted">—</span>}
      </td>
    ),
  },
  { id: "duration", label: "Duration", toggleable: true, defaultVisible: true, sortKey: "duration", thClassName: "num", cell: (s) => <td className="num">{fmtDuration(s.duration_ms)}</td> },
  {
    id: "cost",
    label: "Cost",
    toggleable: true,
    defaultVisible: false, // opt-in: cost lives on the session detail page; ccusage owns the cost story
    sortKey: "cost",
    thClassName: "num",
    cell: (s) => <td className="num" title="Estimated at API list prices (cache-aware)">{fmtCost(s.cost)}</td>,
  },
  { id: "started", label: "Started", toggleable: true, defaultVisible: true, sortKey: "started", cell: (s) => <td>{fmtDate(s.started_at)}</td> },
];

const TOGGLEABLE = COLUMNS.filter((c) => c.toggleable);
const COLS_STORAGE_KEY = "agentlens.sessions.columns";

/** Load the persisted set of visible toggleable-column ids, falling back to each column's default.
 * Guards against a malformed/stale value and unknown ids so the table always renders. */
function loadVisibleCols(): Set<string> {
  const fallback = () => new Set(TOGGLEABLE.filter((c) => c.defaultVisible).map((c) => c.id));
  try {
    const raw = localStorage.getItem(COLS_STORAGE_KEY);
    if (!raw) return fallback();
    const ids = JSON.parse(raw);
    if (!Array.isArray(ids)) return fallback();
    const known = new Set(TOGGLEABLE.map((c) => c.id));
    return new Set(ids.filter((id): id is string => typeof id === "string" && known.has(id)));
  } catch {
    return fallback();
  }
}

const PAGE = 50;

// Filter option lists. Severity most-severe-first; error types grouped failures then rejections.
const SEVERITY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "critical", label: "critical" },
  { value: "high", label: "high" },
  { value: "medium", label: "medium" },
  { value: "low", label: "low" },
  { value: "info", label: "info" },
];
const ERROR_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "command-failed", label: "command failed" },
  { value: "file-state", label: "file state" },
  { value: "string-not-found", label: "string not found" },
  { value: "token-limit", label: "token limit" },
  { value: "other", label: "other" },
  { value: "user-rejected", label: "user rejected" },
  { value: "guardrail-blocked", label: "guardrail blocked" },
];

/** A labeled multi-select filter: a <details> dropdown of checkboxes. Value is the selected `value`s;
 * empty = no filter. Mirrors the column-customizer dropdown (shares the `.col-menu` panel styles). */
function MultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: Array<{ value: string; label: string }>;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  function toggle(value: string, on: boolean) {
    const set = new Set(selected);
    if (on) set.add(value);
    else set.delete(value);
    // Preserve the option order so URL state is stable regardless of click order.
    onChange(options.map((o) => o.value).filter((v) => set.has(v)));
  }
  return (
    <details className="multi-select">
      <summary aria-label={label}>
        {label}
        {selected.length ? ` (${selected.length})` : ""} ▾
      </summary>
      <div className="col-menu" role="group" aria-label={label}>
        {options.map((o) => (
          <label key={o.value}>
            <input type="checkbox" checked={selected.includes(o.value)} onChange={(e) => toggle(o.value, e.target.checked)} />
            {o.label}
          </label>
        ))}
        {selected.length > 0 && (
          <button type="button" className="ghost small ms-clear" onClick={() => onChange([])}>
            clear
          </button>
        )}
      </div>
    </details>
  );
}

/** Compact gear control that lives in the last header cell of the table; opens a checkbox menu to
 * show/hide the toggleable columns. Uses a native <details> so open/close and keyboard/focus behaviour
 * come for free. */
function ColumnCustomizer({ visible, onToggle }: { visible: Set<string>; onToggle: (id: string, on: boolean) => void }) {
  return (
    <details className="col-customizer">
      <summary aria-label="Show or hide columns" title="Show/hide columns">⚙</summary>
      <div className="col-menu" role="group" aria-label="Toggle columns">
        {TOGGLEABLE.map((c) => (
          <label key={c.id}>
            <input type="checkbox" checked={visible.has(c.id)} onChange={(e) => onToggle(c.id, e.target.checked)} />
            {c.label}
          </label>
        ))}
      </div>
    </details>
  );
}

export default function SessionsView() {
  const [params, setParams] = useSearchParams();
  const [sources, setSources] = useState<Source[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [data, setData] = useState<{ total: number; sessions: SessionSummary[] }>({ total: 0, sessions: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [qInput, setQInput] = useState(params.get("q") ?? "");
  const [visibleCols, setVisibleCols] = useState<Set<string>>(loadVisibleCols);

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
    for (const k of ["source", "project", "model", "q", "sort", "dir", "severity", "error_type"]) {
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

  function toggleColumn(id: string, on: boolean) {
    setVisibleCols((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      try {
        localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        /* private-mode / disabled storage: keep the in-memory choice for this session */
      }
      return next;
    });
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

  // Columns to render, in registry order: non-toggleable always, toggleable when enabled.
  const shownCols = COLUMNS.filter((c) => !c.toggleable || visibleCols.has(c.id));

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
        <MultiSelect
          label="Security"
          options={SEVERITY_OPTIONS}
          selected={(params.get("severity") ?? "").split(",").filter(Boolean)}
          onChange={(next) => setParam("severity", next.join(","))}
        />
        <MultiSelect
          label="Errors"
          options={ERROR_TYPE_OPTIONS}
          selected={(params.get("error_type") ?? "").split(",").filter(Boolean)}
          onChange={(next) => setParam("error_type", next.join(","))}
        />
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
              {shownCols.map((c) =>
                c.sortKey ? (
                  <SortHeader
                    key={c.id}
                    label={c.label}
                    sortKey={c.sortKey}
                    active={sortKey}
                    dir={sortDir}
                    onSort={onSort}
                    defaultDir={c.sortDefaultDir ?? "desc"}
                    className={c.thClassName}
                  />
                ) : (
                  <th key={c.id} className={c.thClassName}>
                    {c.label}
                  </th>
                ),
              )}
              <th className="col-th" aria-label="Columns">
                <ColumnCustomizer visible={visibleCols} onToggle={toggleColumn} />
              </th>
            </tr>
          </thead>
          <tbody>
            {data.sessions.map((s) => (
              <tr key={s.id}>
                {shownCols.map((c) => (
                  <Fragment key={c.id}>{c.cell(s)}</Fragment>
                ))}
                <td className="col-td" />
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Pager page={page} pages={pages} total={data.total} unit="sessions" onPage={(p) => setParam("offset", String((p - 1) * PAGE))} />
    </div>
  );
}
