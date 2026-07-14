import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, apiPost, SNAPSHOT, type Finding, type FindingsPage, type MuteRow, type Project, type SecuritySummary } from "./api";
import { SortHeader, useSort } from "./sort";
import { Pager } from "./Pager";
import { FilterSelect } from "./FilterSelect";
import { fmtDate } from "./format";
import { SeverityTag, SEVERITIES } from "./severity";

const PAGE = 50;
type SortKey = "severity" | "session" | "rule" | "category" | "time";
interface Source { id: string; label: string; session_count: number }

/**
 * Security page (ADR-017/018) — a browsable, filterable, triageable list of the findings the detector
 * raised across all sessions, plus severity KPIs and framework-anchored reference explainers. Counts
 * are over OPEN findings so real, un-cleared issues surface; dismissed/muted drop out of the default
 * view. Triage (mark-safe, bulk, rule-mute) writes to the separate triage store via CSRF-guarded POSTs;
 * those controls are hidden in the static snapshot build (no backend). Reads: GET /api/security/*.
 */
export default function SecurityView() {
  const [params, setParams] = useSearchParams();
  const [summary, setSummary] = useState<SecuritySummary | null>(null);
  const [page, setPage] = useState<FindingsPage>({ total: 0, findings: [] });
  const [mutes, setMutes] = useState<MuteRow[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pageNum, setPageNum] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reloadKey, setReloadKey] = useState(0);
  const { sort, toggle } = useSort<SortKey>("severity", "desc");

  const severity = params.get("severity") ?? "";
  const category = params.get("category") ?? "";
  const rule = params.get("rule") ?? "";
  const session = params.get("session") ?? "";
  const source = params.get("source") ?? "";
  const project = params.get("project") ?? "";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const status = params.get("status") ?? "open";

  // The active filter as a query string (shared by the list fetch and dismiss-all-matching).
  const filterQs = useMemo(() => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries({ severity, category, rule, session, source, project, from, to, status })) if (v) qs.set(k, v);
    return qs;
  }, [severity, category, rule, session, source, project, from, to, status]);

  useEffect(() => {
    api<Source[]>("/sources").then(setSources).catch(() => {});
    api<Project[]>("/projects").then(setProjects).catch(() => {});
  }, []);

  useEffect(() => {
    api<SecuritySummary>("/security/summary").then(setSummary).catch(() => {});
    if (!SNAPSHOT) api<MuteRow[]>("/security/mutes").then(setMutes).catch(() => {});
  }, [reloadKey]);

  useEffect(() => setPageNum(1), [filterQs.toString(), sort.key, sort.dir]);
  useEffect(() => setSelected(new Set()), [filterQs.toString(), sort.key, sort.dir, pageNum, reloadKey]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams(filterQs);
    qs.set("sort", sort.key);
    qs.set("dir", sort.dir);
    qs.set("limit", String(PAGE));
    qs.set("offset", String((pageNum - 1) * PAGE));
    api<FindingsPage>("/security/findings?" + qs.toString())
      .then(setPage)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [filterQs, sort.key, sort.dir, pageNum, reloadKey]);

  const setParam = useCallback(
    (patch: Record<string, string>) => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
      setParams(next);
    },
    [params, setParams],
  );

  // Writes: run the action, then clear selection + reload summary/list/mutes.
  const act = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const sevCounts = useMemo(() => new Map((summary?.by_severity ?? []).map((r) => [r.severity, r.n])), [summary]);
  // Rules dropdown shows only rules of the selected category (all rules when none selected).
  const ruleOptions = useMemo(() => (summary?.by_rule ?? []).filter((r) => !category || r.category === category), [summary, category]);

  const pages = Math.max(1, Math.ceil(page.total / PAGE));
  const anyFilter = [...filterQs.keys()].some((k) => k !== "status") || status !== "open";
  const pageIds = page.findings.map((f) => f.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  const toggleSel = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  return (
    <div>
      <div className="detail-head">
        <h1>Security findings</h1>
        <p className="muted" style={{ margin: "4px 0 0", maxWidth: 760 }}>
          Risky operations the agent performed, flagged after the fact by deterministic rules over each
          tool call. Counts show <strong>open</strong> findings — mark benign ones safe or mute a noisy
          rule so a real one stands out. agent-lens is retrospective; it surfaces what <em>happened</em>,
          it doesn't block.
        </p>
      </div>

      {SNAPSHOT && (
        <div className="demo-note" role="note">
          📦 This is a static demo over synthetic sessions. Browse the findings and reference below —
          {" "}<strong>triage</strong> (mark safe, mute rules) and live filtering run in the local app on
          your own data.
        </div>
      )}

      {/* Severity KPI row (open counts). Each tile filters the list. */}
      <div className="kpi-row sev-kpis" role="group" aria-label="Open findings by severity">
        <button type="button" className={"kpi kpi-btn" + (!severity ? " is-active" : "")} onClick={() => setParam({ severity: "" })}>
          <div className="kpi-label">Open findings</div>
          <div className="kpi-value">{summary?.total ?? "—"}</div>
          <div className="kpi-sub">{summary?.sessions_flagged ?? 0} sessions flagged</div>
        </button>
        {SEVERITIES.map((sv) => (
          <button
            key={sv}
            type="button"
            className={"kpi kpi-btn sev-kpi sev-" + sv + (severity === sv ? " is-active" : "")}
            onClick={() => setParam({ severity: severity === sv ? "" : sv })}
            aria-pressed={severity === sv}
          >
            <div className="kpi-label">{sv}</div>
            <div className="kpi-value">{sevCounts.get(sv) ?? 0}</div>
          </button>
        ))}
      </div>

      {/* Triage counts: quick links into the dismissed / muted views. */}
      {summary && (summary.dismissed > 0 || summary.muted > 0) && (
        <div className="triage-counts muted small">
          <button type="button" className="linkish" onClick={() => setParam({ status: "dismissed", severity: "" })}>
            {summary.dismissed} dismissed
          </button>
          {" · "}
          <button type="button" className="linkish" onClick={() => setParam({ status: "muted", severity: "" })}>
            {summary.muted} muted by rule
          </button>
        </div>
      )}

      {/* Filter bar. */}
      <div className="filters">
        <select aria-label="Filter by status" value={status} onChange={(e) => setParam({ status: e.target.value })}>
          <option value="open">open</option>
          <option value="dismissed">dismissed</option>
          <option value="muted">muted</option>
          <option value="all">all</option>
        </select>
        <select
          aria-label="Filter by category"
          value={category}
          onChange={(e) => {
            // Changing category clears a now-mismatched rule so the list can't filter to nothing.
            const nextCat = e.target.value;
            const keepRule = !rule || ruleOptions.some((r) => r.rule_id === rule && (!nextCat || r.category === nextCat));
            setParam({ category: nextCat, rule: keepRule ? rule : "" });
          }}
        >
          <option value="">all categories</option>
          {(summary?.categories ?? []).map((c) => (
            <option key={c.key} value={c.key}>{c.title}</option>
          ))}
        </select>
        <select aria-label="Filter by rule" value={rule} onChange={(e) => setParam({ rule: e.target.value })}>
          <option value="">all rules</option>
          {ruleOptions.map((r) => (
            <option key={r.rule_id} value={r.rule_id}>{r.rule_id} ({r.n})</option>
          ))}
        </select>
        <select aria-label="Filter by source" value={source} onChange={(e) => setParam({ source: e.target.value })}>
          <option value="">all sources</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
        <FilterSelect
          ariaLabel="Filter by project"
          searchPlaceholder="Find project…"
          value={project}
          onChange={(v) => setParam({ project: v })}
          options={[{ value: "", label: "all projects" }, ...projects.map((p) => ({ value: p.id, label: p.path.replace(/^.*\//, "") }))]}
        />
        <label className="ctl">from <input type="date" value={from} onChange={(e) => setParam({ from: e.target.value })} /></label>
        <label className="ctl">to <input type="date" value={to} onChange={(e) => setParam({ to: e.target.value })} /></label>
        {session && (
          <span className="tag" style={{ alignSelf: "center" }}>
            session {session.slice(0, 8)}… <button type="button" className="linkish" onClick={() => setParam({ session: "" })}>✕</button>
          </span>
        )}
        {anyFilter && (
          <button type="button" className="ghost" onClick={() => setParams(new URLSearchParams())}>clear filters</button>
        )}
      </div>

      {/* Action bar: batch triage of the current selection + bulk dismiss of the whole filter. */}
      {!SNAPSHOT && (selected.size > 0 || (status === "open" && page.total > 0)) && (
        <div className="triage-bar" role="group" aria-label="Triage actions">
          {selected.size > 0 && status !== "dismissed" && (
            <button type="button" disabled={busy} onClick={() => act(() => apiPost("/security/dismiss", { ids: [...selected] }))}>
              ✓ Mark {selected.size} safe
            </button>
          )}
          {selected.size > 0 && status === "dismissed" && (
            <button type="button" disabled={busy} onClick={() => act(() => apiPost("/security/reopen", { ids: [...selected] }))}>
              ↩ Reopen {selected.size}
            </button>
          )}
          {selected.size > 0 && <button type="button" className="ghost" onClick={() => setSelected(new Set())}>clear selection</button>}
          {status === "open" && page.total > 0 && (
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => {
                if (confirm(`Dismiss all ${page.total} open findings matching the current filter as safe?`))
                  act(() => apiPost("/security/dismiss-matching", { filter: Object.fromEntries(filterQs) }));
              }}
              title="Mark every open finding matching the current filter as safe"
            >
              Dismiss all {page.total} matching
            </button>
          )}
        </div>
      )}

      {error && <div className="error" role="alert">{error}</div>}
      {loading ? (
        <div className="muted pad" role="status" aria-live="polite">Loading…</div>
      ) : page.findings.length === 0 ? (
        <div className="muted pad" role="status">
          {summary && summary.total === 0 && status === "open"
            ? "No open security findings — nothing risky is awaiting review."
            : "No findings match these filters."}
        </div>
      ) : (
        <table className="sessions findings-table">
          <thead>
            <tr>
              {!SNAPSHOT && (
                <th className="check-col">
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    checked={allSelected}
                    onChange={(e) => setSelected(e.target.checked ? new Set(pageIds) : new Set())}
                  />
                </th>
              )}
              <SortHeader label="Severity" sortKey="severity" active={sort.key} dir={sort.dir} onSort={toggle} />
              <th>Finding</th>
              <SortHeader label="Category" sortKey="category" active={sort.key} dir={sort.dir} onSort={toggle} />
              <th>Evidence</th>
              <SortHeader label="When" sortKey="time" active={sort.key} dir={sort.dir} onSort={toggle} />
              <SortHeader label="Session" sortKey="session" active={sort.key} dir={sort.dir} onSort={toggle} />
              {!SNAPSHOT && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {page.findings.map((f) => (
              <FindingRow
                key={f.id}
                f={f}
                selected={selected.has(f.id)}
                onToggle={() => toggleSel(f.id)}
                busy={busy}
                onDismiss={() => act(() => apiPost("/security/dismiss", { ids: [f.id] }))}
                onReopen={() => act(() => apiPost("/security/reopen", { ids: [f.id] }))}
                onMute={() => act(() => apiPost("/security/mute", { rule_id: f.rule_id, scope: "global" }))}
              />
            ))}
          </tbody>
        </table>
      )}

      {!loading && page.total > PAGE && <Pager page={pageNum} pages={pages} total={page.total} unit="findings" onPage={setPageNum} />}

      {!SNAPSHOT && mutes.length > 0 && <MutedRulesPanel mutes={mutes} busy={busy} onUnmute={(m) => act(() => apiPost("/security/unmute", { rule_id: m.rule_id, scope: m.scope, scope_id: m.scope_id }))} />}

      {summary && summary.categories.length > 0 && <ReferenceSection summary={summary} />}
    </div>
  );
}

function FindingRow({
  f, selected, onToggle, busy, onDismiss, onReopen, onMute,
}: {
  f: Finding;
  selected: boolean;
  onToggle: () => void;
  busy: boolean;
  onDismiss: () => void;
  onReopen: () => void;
  onMute: () => void;
}) {
  const to = `/session/${f.session_id}${f.event_uuid ? `#ev-${f.event_uuid}` : ""}`;
  return (
    <tr className={f.dismissed ? "is-dismissed" : ""}>
      {!SNAPSHOT && (
        <td className="check-col">
          <input type="checkbox" aria-label="Select finding" checked={selected} onChange={onToggle} />
        </td>
      )}
      <td>
        <SeverityTag severity={f.severity} />
        {f.dismissed ? <span className="tag" style={{ marginLeft: 4 }} title={f.dismiss_note ?? ""}>safe</span> : null}
      </td>
      <td>
        <div className="finding-title">{f.title ?? f.rule_id}</div>
        <div className="muted small">
          <code>{f.rule_id}</code>
          {f.framework_ref && <span className="tag framework" style={{ marginLeft: 6 }}>{f.framework_ref}</span>}
        </div>
      </td>
      <td className="small">{f.category}</td>
      <td className="finding-evidence-cell">
        {f.tool_name && <span className="tag tool-tag" title="Tool the finding fired on">{f.tool_name}</span>}
        <code title={f.evidence ?? ""}>{f.evidence}</code>
      </td>
      <td className="small muted" title={f.started_at ?? ""}>{fmtDate(f.started_at ?? null)}</td>
      <td className="small">
        <Link to={to} className="title">{f.session_title || f.session_id.slice(0, 12)}</Link>
        {f.is_sidechain ? <span className="tag subagent" style={{ marginLeft: 6 }}>subagent</span> : null}
        {f.project_path && <div className="muted path">{f.project_path.replace(/^.*\//, "")}</div>}
      </td>
      {!SNAPSHOT && (
        <td className="finding-actions small">
          {f.dismissed ? (
            <button type="button" className="linkish" disabled={busy} onClick={onReopen}>reopen</button>
          ) : (
            <button type="button" className="linkish" disabled={busy} onClick={onDismiss}>safe</button>
          )}
          <button type="button" className="linkish" disabled={busy} onClick={onMute} title={`Mute rule ${f.rule_id} everywhere`}>mute rule</button>
        </td>
      )}
    </tr>
  );
}

/** The muted-rules management panel: each muted rule + scope, with unmute. */
function MutedRulesPanel({ mutes, busy, onUnmute }: { mutes: MuteRow[]; busy: boolean; onUnmute: (m: MuteRow) => void }) {
  return (
    <details className="card muted-rules">
      <summary><span className="sec-ref-title">Muted rules ({mutes.length})</span></summary>
      <ul className="muted-rules-list">
        {mutes.map((m) => (
          <li key={`${m.rule_id}:${m.scope}:${m.scope_id}`}>
            <code>{m.rule_id}</code>
            <span className="tag" style={{ marginLeft: 6 }}>{m.scope}{m.scope_id ? `: ${m.scope_id}` : ""}</span>
            {m.note && <span className="muted small" style={{ marginLeft: 6 }}>{m.note}</span>}
            <button type="button" className="linkish" style={{ marginLeft: 8 }} disabled={busy} onClick={() => onUnmute(m)}>unmute</button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Framework-anchored "what & why" explainers — the reference half of the security page. */
function ReferenceSection({ summary }: { summary: SecuritySummary }) {
  const catCounts = new Map(summary.by_category.map((c) => [c.category, c.n]));
  return (
    <section className="sec-reference">
      <h2>Risk categories</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        What each category means and why it matters, anchored to OWASP Top 10 for Agentic Apps and MITRE ATLAS.
      </p>
      <div className="sec-ref-grid">
        {summary.categories.map((c) => (
          <details key={c.key} className="card sec-ref">
            <summary>
              <span className="sec-ref-title">{c.title}</span>
              <a className="tag framework" href={c.framework_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                {c.framework_ref} ↗
              </a>
              <span className="muted small">{catCounts.get(c.key) ?? 0} open</span>
            </summary>
            <dl className="sec-ref-body">
              <dt>What</dt><dd>{c.what}</dd>
              <dt>Why it matters</dt><dd>{c.why}</dd>
              <dt>What to do</dt><dd>{c.remediation}</dd>
            </dl>
          </details>
        ))}
      </div>
    </section>
  );
}
