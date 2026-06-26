import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type SessionSummary } from "./api";
import { fmtCost, fmtDate, fmtDuration, fmtTokens, shortModel } from "./format";

interface Source {
  id: string;
  label: string;
  session_count: number;
}

const PAGE = 50;

export default function SessionsView() {
  const [params, setParams] = useSearchParams();
  const [sources, setSources] = useState<Source[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [data, setData] = useState<{ total: number; sessions: SessionSummary[] }>({ total: 0, sessions: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [qInput, setQInput] = useState(params.get("q") ?? "");

  const offset = Number(params.get("offset") ?? 0);

  useEffect(() => {
    api<Source[]>("/sources").then(setSources).catch(() => {});
    api<string[]>("/models").then(setModels).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    for (const k of ["source", "model", "kind", "q"]) {
      const v = params.get(k);
      if (v) qs.set(k, v);
    }
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

  const page = Math.floor(offset / PAGE) + 1;
  const pages = Math.max(1, Math.ceil(data.total / PAGE));

  return (
    <div>
      <h1 className="sr-only">Sessions</h1>
      <div className="filters">
        <form onSubmit={submitSearch} className="search" role="search">
          <input
            type="search"
            aria-label="Search transcripts (full-text)"
            placeholder="Search transcripts (full-text)…"
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
        <select aria-label="Filter by model" value={params.get("model") ?? ""} onChange={(e) => setParam("model", e.target.value)}>
          <option value="">all models</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {shortModel(m)}
            </option>
          ))}
        </select>
        <select aria-label="Filter by kind" value={params.get("kind") ?? ""} onChange={(e) => setParam("kind", e.target.value)}>
          <option value="">main + subagents</option>
          <option value="main">main only</option>
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
              <th>Session</th>
              <th>Source</th>
              <th>Project</th>
              <th className="num">Turns</th>
              <th className="num">Tokens</th>
              <th className="num">Cost</th>
              <th className="num">Duration</th>
              <th>Started</th>
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
                <td className="num">{fmtTokens(s.tokens)}</td>
                <td className="num">{fmtCost(s.cost)}</td>
                <td className="num">{fmtDuration(s.duration_ms)}</td>
                <td>{fmtDate(s.started_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="pager">
        <button disabled={offset <= 0} onClick={() => setParam("offset", String(Math.max(0, offset - PAGE)))}>
          ← Prev
        </button>
        <span className="muted">
          page {page} / {pages} · {data.total} sessions
        </span>
        <button disabled={page >= pages} onClick={() => setParam("offset", String(offset + PAGE))}>
          Next →
        </button>
      </div>
    </div>
  );
}
