import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  Cell,
} from "recharts";
import { Link } from "react-router-dom";
import { api, type DashOverview, type DashTimeseries, type DashBreakdowns, type TokenSplit, type SecuritySummary } from "./api";
import { fmtCost, fmtTokens, fmtDuration, shortModel } from "./format";
import { ChartCard, Kpi, useChartTokens } from "./charts/theme";
import { loadPrefLocal, fetchPref, savePref } from "./prefs";

/** Dashboard security tile: OPEN critical/high counts (global; dismissed + muted excluded), linking to
 * the /security page. A muted, all-clear tile when nothing open remains. */
function SecurityKpi({ s }: { s: SecuritySummary }) {
  const bySev = new Map(s.by_severity.map((r) => [r.severity, r.n]));
  const critical = bySev.get("critical") ?? 0;
  const high = bySev.get("high") ?? 0;
  const value = s.total === 0 ? "—" : `${critical} / ${high}`;
  return (
    <Link
      className={"kpi kpi-btn" + (critical > 0 ? " sev-critical" : high > 0 ? " sev-high" : "")}
      to="/security"
      title="Security findings — critical / high. Opens the Security page."
    >
      <div className="kpi-label">Security findings</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">
        {s.total === 0 ? "no open findings" : `critical / high · ${s.total} open in ${s.sessions_flagged} sessions`}
      </div>
    </Link>
  );
}

/** The four token components as a compact, color-keyed breakdown that complements the "Total tokens"
 * KPI and the "Tokens over time" chart — same colors, exact totals + share at a glance. */
function TokenBreakdownKpi({ t }: { t: TokenSplit }) {
  const { TOKEN_COLORS } = useChartTokens();
  const total = t.input + t.output + t.cache_creation + t.cache_read;
  const rows: Array<{ name: string; v: number; c: string }> = [
    { name: "Input", v: t.input, c: TOKEN_COLORS.input },
    { name: "Output", v: t.output, c: TOKEN_COLORS.output },
    { name: "Cache write", v: t.cache_creation, c: TOKEN_COLORS.cache_creation },
    { name: "Cache read", v: t.cache_read, c: TOKEN_COLORS.cache_read },
  ];
  return (
    <div className="kpi" title="Token totals by type: input · output · cache-write · cache-read">
      <div className="kpi-label">Token breakdown</div>
      <ul className="kpi-bd">
        {rows.map((r) => (
          <li key={r.name}>
            <span className="kpi-bd-dot" style={{ background: r.c }} aria-hidden="true" />
            <span className="kpi-bd-name">{r.name}</span>
            <span className="kpi-bd-val">{fmtTokens(r.v)}</span>
            <span className="kpi-bd-pct">{total ? Math.round((r.v / total) * 100) : 0}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface Source {
  id: string;
  label: string;
  session_count: number;
}

const BAND_ORDER = ["trivial", "small", "medium", "large", "xl"];

/** Default rows shown for a ranked bar list before the user expands it ("show all"). Keeps every card
 * at the standard height so grid rows stay even; the full list is one click away. */
const TOP_N = 8;
/** Approx px per horizontal bar row, used to size a card when it is expanded to show its full list. */
const ROW_PX = 26;

/** Every dashboard chart, in render order — the source of truth for the show/hide customizer. Ids are
 * stable keys; the persisted pref stores the HIDDEN ids (so a chart added later defaults to visible). */
const CHART_REGISTRY: Array<{ id: string; label: string }> = [
  { id: "tokens-over-time", label: "Tokens over time" },
  { id: "cost-over-time", label: "Cost over time" },
  { id: "activity", label: "Activity over time" },
  { id: "tool-errors", label: "Tool errors over time" },
  { id: "error-types", label: "Error types" },
  { id: "tokens-by-model", label: "Tokens by model" },
  { id: "category", label: "Category distribution" },
  { id: "complexity", label: "Complexity bands" },
  { id: "tool-frequency", label: "Tool frequency" },
  { id: "skill-activation", label: "Skill activation" },
  { id: "subagent-fanout", label: "Subagent fan-out" },
];
const CHARTS_PREF_KEY = "dashboard.charts";

/** Gear menu to show/hide chart cards. Mirrors the Sessions column customizer (same `.col-customizer`
 * /`.col-menu` styles, native `<details>` for keyboard/focus). Checkbox checked = visible. */
function ChartCustomizer({ hidden, onToggle }: { hidden: Set<string>; onToggle: (id: string, visible: boolean) => void }) {
  return (
    <details className="col-customizer">
      <summary aria-label="Show or hide charts" title="Show/hide charts">⚙</summary>
      <div className="col-menu" role="group" aria-label="Toggle charts">
        {CHART_REGISTRY.map((c) => (
          <label key={c.id}>
            <input type="checkbox" checked={!hidden.has(c.id)} onChange={(e) => onToggle(c.id, e.target.checked)} />
            {c.label}
          </label>
        ))}
      </div>
    </details>
  );
}

type SkillVersionRow = DashBreakdowns["skill_versions"][number];

/** Read-only hover for the grouped skill bar: the skill's total + each version's firing count.
 * (Recharts tooltips aren't interactive, so the per-version links live on the skill page; click the
 * bar to go there.) */
function SkillTooltip({ active, payload, versionsByName }: any) {
  const { C, tooltipStyle } = useChartTokens();
  if (!active || !payload?.length) return null;
  const name: string = payload[0]?.payload?.name;
  const total: number = payload[0]?.payload?.n ?? 0;
  const versions: SkillVersionRow[] = versionsByName.get(name) ?? [];
  return (
    <div style={{ ...tooltipStyle.contentStyle, padding: "8px 10px", maxWidth: 280 }}>
      <div style={{ color: C.text, fontWeight: 600, marginBottom: 4 }}>{name}</div>
      <div style={{ color: C.muted, marginBottom: versions.length ? 6 : 0 }}>{total} firing{total === 1 ? "" : "s"} total</div>
      {versions.map((v) => (
        <div key={v.version_id} style={{ color: C.text, display: "flex", justifyContent: "space-between", gap: 12 }}>
          <span style={{ color: C.muted }}>{v.version_id.slice(0, 8)}</span>
          <span>{v.n}</span>
        </div>
      ))}
      {versions.length > 0 && <div style={{ color: C.muted, marginTop: 6, fontSize: 11 }}>click to open skill →</div>}
    </div>
  );
}

/** A clickable category-axis label for drill-down bar charts, so a bar too short to click is still
 * reachable via its label. Renders the tick text with a pointer cursor; clicking calls `onSelect` with
 * the label value. Styled via `.axis-link` (muted → accent + underline on hover). */
function AxisLink({ x, y, payload, onSelect, title }: any) {
  return (
    <text x={x} y={y} dy={4} textAnchor="end" className="axis-link" fontSize={11} onClick={() => onSelect(payload?.value)}>
      {title && <title>{title}</title>}
      {payload?.value}
    </text>
  );
}

export default function Dashboard() {
  const { C, TOKEN_COLORS, PALETTE, axisProps, gridProps, tooltipStyle } = useChartTokens();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [sources, setSources] = useState<Source[]>([]);
  const [overview, setOverview] = useState<DashOverview | null>(null);
  const [ts, setTs] = useState<DashTimeseries | null>(null);
  const [bd, setBd] = useState<DashBreakdowns | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Security summary is global (not source/date filtered), so fetch it once on mount like sources.
  const [security, setSecurity] = useState<SecuritySummary | null>(null);
  // Which ranked bar cards are expanded to their full list (see TOP_N). Ephemeral view state.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Hidden chart ids (persisted). Paint from localStorage, then reconcile with the server pref.
  const [hiddenCharts, setHiddenCharts] = useState<Set<string>>(() => new Set(loadPrefLocal<string[]>(CHARTS_PREF_KEY, [])));
  useEffect(() => {
    fetchPref<string[]>(CHARTS_PREF_KEY).then((v) => v && setHiddenCharts(new Set(v)));
  }, []);
  const vis = (id: string) => !hiddenCharts.has(id);
  const toggleChart = (id: string, visible: boolean) =>
    setHiddenCharts((prev) => {
      const next = new Set(prev);
      if (visible) next.delete(id);
      else next.add(id);
      savePref(CHARTS_PREF_KEY, [...next]);
      return next;
    });
  // Per-chart metric toggle for "Tokens by model" (both values are already in the data).
  const [modelMetric, setModelMetric] = useState<"tokens" | "cost">("tokens");
  // Series hidden via the "Tokens over time" legend (click to toggle). Hiding the dominant cache-read
  // series lets the others use the full scale. Restacks automatically.
  const [hiddenTokenSeries, setHiddenTokenSeries] = useState<Set<string>>(new Set());
  const toggleTokenSeries = (key: string) =>
    setHiddenTokenSeries((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  useEffect(() => {
    api<Source[]>("/sources").then(setSources).catch(() => {});
    api<SecuritySummary>("/security/summary").then(setSecurity).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    for (const k of ["source", "from", "to", "bucket"]) {
      const v = params.get(k);
      if (v) qs.set(k, v);
    }
    const s = qs.toString() ? "?" + qs.toString() : "";
    Promise.all([
      api<DashOverview>("/dashboard/overview" + s),
      api<DashTimeseries>("/dashboard/timeseries" + s),
      api<DashBreakdowns>("/dashboard/breakdowns" + s),
    ])
      .then(([o, t, b]) => {
        setOverview(o);
        setTs(t);
        setBd(b);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [params]);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  }

  const categoryData = (bd?.by_category ?? []).map((c) => ({ name: c.category, value: c.n }));
  const complexityData = BAND_ORDER.map((band) => ({
    name: band,
    value: bd?.by_complexity.find((b) => b.band === band)?.n ?? 0,
  })).filter((d) => d.value > 0);
  // Keep the full model id alongside the short display name so a bar can deep-link to the Sessions
  // model filter (which matches on the full id).
  const modelData = (bd?.by_model ?? []).map((m) => ({ name: shortModel(m.model), model: m.model, tokens: m.total_tokens, cost: m.cost }));
  const errorTypeData = (bd?.error_types?.by_type ?? []).map((e) => ({ name: e.type, n: e.n, kind: e.kind }));
  // Error-rate KPIs: failures/rejections as a share of all tool calls (the raw counts already exist;
  // the *rate* is the missing headline). Both come from the breakdowns payload, tool_calls from overview.
  const errFailures = bd?.error_types?.failures ?? 0;
  const errRejections = bd?.error_types?.rejections ?? 0;
  const toolCalls = overview?.tool_calls ?? 0;
  const errRate = toolCalls ? (errFailures / toolCalls) * 100 : 0;
  const rejRate = toolCalls ? (errRejections / toolCalls) * 100 : 0;
  // Group skill versions under each skill name for the bar's hover breakdown (bars show the per-name total).
  const versionsByName = new Map<string, SkillVersionRow[]>();
  for (const v of bd?.skill_versions ?? []) {
    const arr = versionsByName.get(v.name) ?? [];
    arr.push(v);
    versionsByName.set(v.name, arr);
  }

  // Ranked bar lists show a top-N by default (even card heights) and expand on demand. `topN` slices,
  // `expandBtn` renders the header toggle, and `expandHeight` grows just that card while expanded.
  const topN = <T,>(arr: T[], id: string): T[] => (expanded.has(id) ? arr : arr.slice(0, TOP_N));
  const expandHeight = (id: string, total: number, rowPx = ROW_PX): number | undefined =>
    expanded.has(id) ? Math.max(240, total * rowPx) : undefined;
  const expandBtn = (id: string, total: number) => {
    if (total <= TOP_N) return undefined;
    return (
      <button type="button" className="link-btn" onClick={() => toggleExpand(id)}>
        {expanded.has(id) ? `show top ${TOP_N}` : `show all (${total})`}
      </button>
    );
  };
  // Open the Sessions list (the index route "/") filtered to a slice, reusing the Sessions view's URL
  // filters (`error_type`, `model`, …). `sessionsFilterUrl` builds the link; `drillTo` is the
  // bar/label click handler; `field` is the datum field to read the value from.
  const sessionsFilterUrl = (param: string, value: string) => `/?${param}=${encodeURIComponent(value)}`;
  const drillFilter = (param: string, value: string | null | undefined) => {
    if (value != null && value !== "") navigate(sessionsFilterUrl(param, value));
  };
  const drillTo = (param: string, field: string) => (datum: any) => drillFilter(param, datum?.payload?.[field] ?? datum?.[field]);

  return (
    <div>
      <h1 className="sr-only">Dashboard</h1>
      <div className="filters">
        <select aria-label="Filter by source" value={params.get("source") ?? ""} onChange={(e) => setParam("source", e.target.value)}>
          <option value="">all sources</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label} ({s.session_count})
            </option>
          ))}
        </select>
        <label className="ctl">
          from <input type="date" value={params.get("from") ?? ""} onChange={(e) => setParam("from", e.target.value)} />
        </label>
        <label className="ctl">
          to <input type="date" value={params.get("to") ?? ""} onChange={(e) => setParam("to", e.target.value)} />
        </label>
        <select aria-label="Time bucket" value={params.get("bucket") ?? ""} onChange={(e) => setParam("bucket", e.target.value)}>
          <option value="">bucket: auto{ts ? ` (${ts.bucket})` : ""}</option>
          <option value="day">day</option>
          <option value="week">week</option>
          <option value="month">month</option>
        </select>
      </div>

      {error && <div className="error" role="alert">{error}</div>}
      {loading && <div className="muted pad" role="status" aria-live="polite">Loading…</div>}

      {overview && !loading && (
        <>
          <div className="kpis">
            <Kpi label="Sessions" value={overview.sessions_main} sub={`+${overview.sessions_subagent.toLocaleString()} subagent runs`} />
            <Kpi label="Projects" value={overview.projects} sub="distinct project paths" />
            <Kpi label="Turns" value={overview.turns} sub={`${overview.tool_calls.toLocaleString()} tool calls`} />
            <Kpi
              label="Tool error rate"
              value={toolCalls ? errRate.toFixed(1) + "%" : "—"}
              title="Genuine tool failures as a share of all tool calls (rejections/blocks excluded — see the rejection rate)."
              sub={`${errFailures.toLocaleString()} failed of ${toolCalls.toLocaleString()} calls`}
            />
            <Kpi
              label="Rejection rate"
              value={toolCalls ? rejRate.toFixed(1) + "%" : "—"}
              title="User-rejected + guardrail-blocked tool calls as a share of all tool calls. Not agent failures."
              sub={`${errRejections.toLocaleString()} rejected/blocked`}
            />
            <Kpi
              label="Workflow runs"
              value={overview.workflows.total || "—"}
              title="Async workflow runs in range. Success rate is over decided runs (completed vs failed); in-flight runs are excluded from the rate."
              sub={
                overview.workflows.total
                  ? `${Math.round(overview.workflows.success_rate * 100)}% success · ${fmtTokens(overview.workflows.total_tokens)}`
                  : "no workflow runs"
              }
            />
            <Kpi
              label="Est. cost (API-equiv.)"
              value={fmtCost(overview.cost)}
              title="Estimated at API list prices for this usage (cache reads/writes included at their discounted cache rates)."
              sub={overview.unpriced_models.length ? `⚠ unpriced: ${overview.unpriced_models.map(shortModel).join(", ")}` : "API list price estimate"}
            />
            <Kpi
              label="Cost / session"
              value={overview.sessions_main ? fmtCost(overview.cost / overview.sessions_main) : "—"}
              title="Estimated API-equivalent cost divided by main sessions in range."
              sub="API-equiv. per main session"
            />
            <Kpi
              label="Cache-read ratio"
              value={(overview.cache_read_ratio * 100).toFixed(1) + "%"}
              sub="of all tokens are cached replays — excluded from “work”"
            />
            <Kpi label="Turn duration p50 / p95" value={`${fmtDuration(overview.turn_duration_ms.p50)} / ${fmtDuration(overview.turn_duration_ms.p95)}`} sub={`${overview.turn_duration_ms.count} turns`} />
            <Kpi
              label="Session duration p50 / p95"
              value={`${fmtDuration(overview.session_duration_ms.p50)} / ${fmtDuration(overview.session_duration_ms.p95)}`}
              title="End-to-end wall-clock length of main sessions (subagents excluded)."
              sub={`${overview.session_duration_ms.count} sessions`}
            />
            <Kpi label="Total tokens" value={fmtTokens(overview.total_tokens)} sub={`${fmtTokens(overview.tokens.input + overview.tokens.output)} non-cache`} />
            <TokenBreakdownKpi t={overview.tokens} />
            {security && <SecurityKpi s={security} />}
          </div>

          <div className="dash-toolbar">
            <ChartCustomizer hidden={hiddenCharts} onToggle={toggleChart} />
          </div>

          <div className="cards">
            <ChartCard
              title="Tokens over time"
              hint="input · output · cache-write · cache-read (kept separate)"
              hidden={!vis("tokens-over-time")}
            >
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={ts?.series ?? []} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="bucket" {...axisProps} minTickGap={24} />
                  <YAxis {...axisProps} tickFormatter={(v) => fmtTokens(v as number)} width={48} />
                  <Tooltip {...tooltipStyle} formatter={(v: any, n: any) => [fmtTokens(Number(v)), n]} />
                  <Legend
                    wrapperStyle={{ fontSize: 12, cursor: "pointer" }}
                    onClick={(o: any) => o?.dataKey && toggleTokenSeries(String(o.dataKey))}
                    formatter={(value: any, entry: any) => (
                      <span style={{ opacity: hiddenTokenSeries.has(String(entry?.dataKey)) ? 0.4 : 1 }}>{value}</span>
                    )}
                  />
                  <Area type="monotone" dataKey="input" hide={hiddenTokenSeries.has("input")} stackId="1" stroke={TOKEN_COLORS.input} fill={TOKEN_COLORS.input} fillOpacity={0.5} />
                  <Area type="monotone" dataKey="output" hide={hiddenTokenSeries.has("output")} stackId="1" stroke={TOKEN_COLORS.output} fill={TOKEN_COLORS.output} fillOpacity={0.5} />
                  <Area type="monotone" dataKey="cache_creation" hide={hiddenTokenSeries.has("cache_creation")} stackId="1" stroke={TOKEN_COLORS.cache_creation} fill={TOKEN_COLORS.cache_creation} fillOpacity={0.5} />
                  <Area type="monotone" dataKey="cache_read" hide={hiddenTokenSeries.has("cache_read")} stackId="1" stroke={TOKEN_COLORS.cache_read} fill={TOKEN_COLORS.cache_read} fillOpacity={0.35} />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Cost over time" hint="API list price estimate, model × tokens (cache-aware)" hidden={!vis("cost-over-time")}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={ts?.series ?? []} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="bucket" {...axisProps} minTickGap={24} />
                  <YAxis {...axisProps} tickFormatter={(v) => "$" + v} width={48} />
                  <Tooltip {...tooltipStyle} formatter={(v: any) => fmtCost(Number(v))} />
                  <Line type="monotone" dataKey="cost" stroke={C.red} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Activity over time" hint="sessions & turns per bucket" hidden={!vis("activity")}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={ts?.series ?? []} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="bucket" {...axisProps} minTickGap={24} />
                  <YAxis {...axisProps} width={36} />
                  <Tooltip {...tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="sessions" fill={C.accent} />
                  <Bar dataKey="turns" fill={C.green} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard
              title="Tool errors over time"
              hint="failed tool calls per bucket · rejections/blocks kept separate (not agent failures)"
              hidden={!vis("tool-errors")}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={ts?.series ?? []} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="bucket" {...axisProps} minTickGap={24} />
                  <YAxis {...axisProps} width={36} allowDecimals={false} />
                  <Tooltip {...tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="failures" name="failures" stackId="e" fill={C.red} />
                  <Bar dataKey="rejections" name="rejected/blocked" stackId="e" fill={C.muted} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard
              title="Error types"
              hint="heuristic buckets from the tool result text · rejections/blocks are not agent failures · click a bar for those sessions"
              actions={expandBtn("errors", errorTypeData.length)}
              bodyHeight={expandHeight("errors", errorTypeData.length, 28)}
              hidden={!vis("error-types")}
            >
              {bd && errorTypeData.length === 0 ? (
                <div className="empty">No errored tool calls in range.</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={topN(errorTypeData, "errors")} layout="vertical" margin={{ top: 4, right: 8, left: 24, bottom: 0 }}>
                    <CartesianGrid {...gridProps} horizontal={false} />
                    <XAxis type="number" {...axisProps} allowDecimals={false} />
                    <YAxis
                      type="category"
                      dataKey="name"
                      {...axisProps}
                      width={130}
                      tick={(p: any) => <AxisLink {...p} title="click to filter sessions" onSelect={(v: string) => drillFilter("error_type", v)} />}
                    />
                    <Tooltip {...tooltipStyle} formatter={(v: any, _n: any, p: any) => [`${v} (${p.payload.kind})`, "count"]} />
                    <Bar dataKey="n" cursor="pointer" onClick={drillTo("error_type", "name")}>
                      {topN(errorTypeData, "errors").map((d, i) => (
                        <Cell key={i} fill={d.kind === "rejection" ? C.muted : C.red} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </ChartCard>

            <ChartCard
              title="Tokens by model"
              hint="click a bar for those sessions"
              hidden={!vis("tokens-by-model")}
              actions={
                <span className="seg" role="group" aria-label="Metric">
                  <button type="button" className={modelMetric === "tokens" ? "on" : ""} onClick={() => setModelMetric("tokens")}>
                    tokens
                  </button>
                  <button type="button" className={modelMetric === "cost" ? "on" : ""} onClick={() => setModelMetric("cost")}>
                    cost
                  </button>
                </span>
              }
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={modelData} layout="vertical" margin={{ top: 8, right: 8, left: 24, bottom: 0 }}>
                  <CartesianGrid {...gridProps} horizontal={false} />
                  <XAxis type="number" {...axisProps} tickFormatter={(v) => (modelMetric === "cost" ? fmtCost(Number(v)) : fmtTokens(v as number))} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    {...axisProps}
                    width={120}
                    tick={(p: any) => (
                      <AxisLink {...p} title="click to filter sessions" onSelect={(v: string) => drillFilter("model", modelData.find((m) => m.name === v)?.model)} />
                    )}
                  />
                  <Tooltip {...tooltipStyle} formatter={(_v: any, _n: any, p: any) => [`${fmtTokens(Number(p.payload.tokens))} · ${fmtCost(p.payload.cost)}`, modelMetric]} />
                  <Bar dataKey={modelMetric} cursor="pointer" onClick={drillTo("model", "model")}>
                    {modelData.map((_, i) => (
                      <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Category distribution" hint="main sessions only" hidden={!vis("category")}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={categoryData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="name" {...axisProps} />
                  <YAxis {...axisProps} width={36} allowDecimals={false} />
                  <Tooltip {...tooltipStyle} />
                  <Bar dataKey="value">
                    {categoryData.map((_, i) => (
                      <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Complexity bands" hint="main sessions only" hidden={!vis("complexity")}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={complexityData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="name" {...axisProps} />
                  <YAxis {...axisProps} width={36} allowDecimals={false} />
                  <Tooltip {...tooltipStyle} />
                  <Bar dataKey="value" fill={C.violet} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard
              title="Tool frequency"
              hint="top tools by call count"
              actions={expandBtn("tools", bd?.tools.length ?? 0)}
              bodyHeight={expandHeight("tools", bd?.tools.length ?? 0, 22)}
              hidden={!vis("tool-frequency")}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topN(bd?.tools ?? [], "tools")} layout="vertical" margin={{ top: 4, right: 8, left: 24, bottom: 0 }}>
                  <CartesianGrid {...gridProps} horizontal={false} />
                  <XAxis type="number" {...axisProps} />
                  <YAxis type="category" dataKey="name" {...axisProps} width={110} />
                  <Tooltip {...tooltipStyle} />
                  <Bar dataKey="n" fill={C.teal} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard
              title="Skill activation"
              hint="firings per skill (all versions grouped) · hover for versions · click to open"
              actions={expandBtn("skills", bd?.skills.length ?? 0)}
              bodyHeight={expandHeight("skills", bd?.skills.length ?? 0, 22)}
              hidden={!vis("skill-activation")}
            >
              {bd && bd.skills.length === 0 ? (
                <div className="empty">
                  No <code>Skill</code> tool calls in range. Skill usage is captured from <code>input.skill</code>;
                  this fills in once skills are actually invoked in collected sessions.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={topN(bd?.skills ?? [], "skills")} layout="vertical" margin={{ top: 4, right: 8, left: 24, bottom: 0 }}>
                    <CartesianGrid {...gridProps} horizontal={false} />
                    <XAxis type="number" {...axisProps} />
                    <YAxis
                      type="category"
                      dataKey="name"
                      {...axisProps}
                      width={140}
                      tick={(p: any) => <AxisLink {...p} title="click to open skill" onSelect={(v: string) => v && navigate(`/skill/${encodeURIComponent(v)}`)} />}
                    />
                    <Tooltip cursor={{ fill: C.border, fillOpacity: 0.25 }} content={<SkillTooltip versionsByName={versionsByName} />} />
                    <Bar
                      dataKey="n"
                      fill={C.gold}
                      cursor="pointer"
                      onClick={(d: any) => {
                        const nm = d?.payload?.name ?? d?.name;
                        if (nm) navigate(`/skill/${encodeURIComponent(nm)}`);
                      }}
                    />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </ChartCard>

            <ChartCard
              title="Subagent fan-out"
              hint={
                bd
                  ? `${bd.subagent_fanout.total_spawns} spawns · ${bd.subagent_fanout.sessions_with_subagents} sessions · avg ${bd.subagent_fanout.avg_per_session}, max ${bd.subagent_fanout.max_per_session}`
                  : undefined
              }
              actions={expandBtn("subagents", bd?.subagent_fanout.by_type.length ?? 0)}
              bodyHeight={expandHeight("subagents", bd?.subagent_fanout.by_type.length ?? 0, 28)}
              hidden={!vis("subagent-fanout")}
            >
              {bd && bd.subagent_fanout.by_type.length === 0 ? (
                <div className="empty">No subagents spawned in range.</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={topN(bd?.subagent_fanout.by_type ?? [], "subagents")} layout="vertical" margin={{ top: 4, right: 8, left: 24, bottom: 0 }}>
                    <CartesianGrid {...gridProps} horizontal={false} />
                    <XAxis type="number" {...axisProps} />
                    <YAxis type="category" dataKey="type" {...axisProps} width={120} />
                    <Tooltip {...tooltipStyle} />
                    <Bar dataKey="n" fill={C.accent} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </ChartCard>
          </div>
        </>
      )}
    </div>
  );
}
