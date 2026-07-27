import { Link } from "react-router-dom";
import type { DashBreakdowns, DashOverview, SecuritySummary, TokenSplit } from "../api";
import { fmtCost, fmtDuration, fmtTokens, shortModel } from "../format";
import { Kpi, useChartTokens } from "../charts/theme";

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

/** The dashboard's KPI strip. `security` is fetched separately from the range-filtered payloads (it is
 * global), so it renders only once it lands. */
export function KpiRow({
  overview,
  bd,
  security,
}: {
  overview: DashOverview;
  bd: DashBreakdowns | null;
  security: SecuritySummary | null;
}) {
  // Error-rate KPIs: failures/rejections as a share of all tool calls (the raw counts already exist;
  // the *rate* is the missing headline). Both come from the breakdowns payload, tool_calls from overview.
  const errFailures = bd?.error_types?.failures ?? 0;
  const errRejections = bd?.error_types?.rejections ?? 0;
  const toolCalls = overview.tool_calls ?? 0;
  const errRate = toolCalls ? (errFailures / toolCalls) * 100 : 0;
  const rejRate = toolCalls ? (errRejections / toolCalls) * 100 : 0;

  return (
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
      <Kpi
        label="Turn duration p50 / p95"
        value={`${fmtDuration(overview.turn_duration_ms.p50)} / ${fmtDuration(overview.turn_duration_ms.p95)}`}
        sub={`${overview.turn_duration_ms.count} turns`}
      />
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
  );
}
