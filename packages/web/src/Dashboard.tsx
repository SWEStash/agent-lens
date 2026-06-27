import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
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
import { api, type DashOverview, type DashTimeseries, type DashBreakdowns } from "./api";
import { fmtCost, fmtTokens, fmtDuration, shortModel } from "./format";
import { ChartCard, Kpi, TOKEN_COLORS, PALETTE, C, axisProps, gridProps, tooltipStyle } from "./charts/theme";

interface Source {
  id: string;
  label: string;
  session_count: number;
}

const BAND_ORDER = ["trivial", "small", "medium", "large", "xl"];

export default function Dashboard() {
  const [params, setParams] = useSearchParams();
  const [sources, setSources] = useState<Source[]>([]);
  const [overview, setOverview] = useState<DashOverview | null>(null);
  const [ts, setTs] = useState<DashTimeseries | null>(null);
  const [bd, setBd] = useState<DashBreakdowns | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<Source[]>("/sources").then(setSources).catch(() => {});
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
  const modelData = (bd?.by_model ?? []).map((m) => ({ name: shortModel(m.model), tokens: m.total_tokens, cost: m.cost }));

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
            <Kpi label="Turns" value={overview.turns} sub={`${overview.tool_calls.toLocaleString()} tool calls`} />
            <Kpi
              label="Est. cost (API-equiv.)"
              value={fmtCost(overview.cost)}
              title="Pay-as-you-go API list price for this usage — i.e. what a Pro/Max subscription saves you, NOT money actually spent. Cache reads/writes are included at their (discounted) cache rates."
              sub={overview.unpriced_models.length ? `⚠ unpriced: ${overview.unpriced_models.map(shortModel).join(", ")}` : "API list price, not subscription spend"}
            />
            <Kpi
              label="Cache-read ratio"
              value={(overview.cache_read_ratio * 100).toFixed(1) + "%"}
              sub="of all tokens are cached replays — excluded from “work”"
            />
            <Kpi label="Turn duration p50 / p95" value={`${fmtDuration(overview.turn_duration_ms.p50)} / ${fmtDuration(overview.turn_duration_ms.p95)}`} sub={`${overview.turn_duration_ms.count} turns`} />
            <Kpi label="Total tokens" value={fmtTokens(overview.total_tokens)} sub={`${fmtTokens(overview.tokens.input + overview.tokens.output)} non-cache`} />
          </div>

          <div className="cards">
            <ChartCard
              title="Tokens over time"
              hint="input · output · cache-write · cache-read (kept separate)"
            >
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={ts?.series ?? []} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="bucket" {...axisProps} minTickGap={24} />
                  <YAxis {...axisProps} tickFormatter={(v) => fmtTokens(v as number)} width={48} />
                  <Tooltip {...tooltipStyle} formatter={(v: any, n: any) => [fmtTokens(Number(v)), n]} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Area type="monotone" dataKey="input" stackId="1" stroke={TOKEN_COLORS.input} fill={TOKEN_COLORS.input} fillOpacity={0.5} />
                  <Area type="monotone" dataKey="output" stackId="1" stroke={TOKEN_COLORS.output} fill={TOKEN_COLORS.output} fillOpacity={0.5} />
                  <Area type="monotone" dataKey="cache_creation" stackId="1" stroke={TOKEN_COLORS.cache_creation} fill={TOKEN_COLORS.cache_creation} fillOpacity={0.5} />
                  <Area type="monotone" dataKey="cache_read" stackId="1" stroke={TOKEN_COLORS.cache_read} fill={TOKEN_COLORS.cache_read} fillOpacity={0.35} />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Cost over time" hint="API list price, model × tokens (cache-aware) — not subscription spend">
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={ts?.series ?? []} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="bucket" {...axisProps} minTickGap={24} />
                  <YAxis {...axisProps} tickFormatter={(v) => "$" + v} width={48} />
                  <Tooltip {...tooltipStyle} formatter={(v: any) => fmtCost(Number(v))} />
                  <Line type="monotone" dataKey="cost" stroke={C.red} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Activity over time" hint="sessions & turns per bucket">
              <ResponsiveContainer width="100%" height={220}>
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

            <ChartCard title="Tokens by model" hint="total tokens; cost in tooltip">
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={modelData} layout="vertical" margin={{ top: 8, right: 8, left: 24, bottom: 0 }}>
                  <CartesianGrid {...gridProps} horizontal={false} />
                  <XAxis type="number" {...axisProps} tickFormatter={(v) => fmtTokens(v as number)} />
                  <YAxis type="category" dataKey="name" {...axisProps} width={120} />
                  <Tooltip {...tooltipStyle} formatter={(v: any, _n: any, p: any) => [`${fmtTokens(Number(v))} · ${fmtCost(p.payload.cost)}`, "tokens"]} />
                  <Bar dataKey="tokens">
                    {modelData.map((_, i) => (
                      <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Category distribution" hint="main sessions only">
              <ResponsiveContainer width="100%" height={220}>
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

            <ChartCard title="Complexity bands" hint="main sessions only">
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={complexityData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="name" {...axisProps} />
                  <YAxis {...axisProps} width={36} allowDecimals={false} />
                  <Tooltip {...tooltipStyle} />
                  <Bar dataKey="value" fill={C.violet} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Tool frequency" hint="top tools by call count">
              <ResponsiveContainer width="100%" height={Math.max(160, (bd?.tools.length ?? 0) * 22)}>
                <BarChart data={bd?.tools ?? []} layout="vertical" margin={{ top: 4, right: 8, left: 24, bottom: 0 }}>
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
              hint="Skill tool calls by skill"
            >
              {bd && bd.skills.length === 0 ? (
                <div className="empty">
                  No <code>Skill</code> tool calls in range. Skill usage is captured from <code>input.skill</code>;
                  this fills in once skills are actually invoked in collected sessions.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={Math.max(160, (bd?.skills.length ?? 0) * 22)}>
                  <BarChart data={bd?.skills ?? []} layout="vertical" margin={{ top: 4, right: 8, left: 24, bottom: 0 }}>
                    <CartesianGrid {...gridProps} horizontal={false} />
                    <XAxis type="number" {...axisProps} />
                    <YAxis type="category" dataKey="name" {...axisProps} width={140} />
                    <Tooltip {...tooltipStyle} />
                    <Bar dataKey="n" fill={C.gold} />
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
            >
              {bd && bd.subagent_fanout.by_type.length === 0 ? (
                <div className="empty">No subagents spawned in range.</div>
              ) : (
                <ResponsiveContainer width="100%" height={Math.max(160, (bd?.subagent_fanout.by_type.length ?? 0) * 28)}>
                  <BarChart data={bd?.subagent_fanout.by_type ?? []} layout="vertical" margin={{ top: 4, right: 8, left: 24, bottom: 0 }}>
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
