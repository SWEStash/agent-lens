import { api, type DashOverview, type DashTimeseries, type DashBreakdowns, type SecuritySummary, type Source } from "./api";
import { useAsync, useLookup } from "./useFetch";
import { useQueryState } from "./useQueryState";
import { ErrorAlert, Loading } from "./AsyncBoundary";
import { useExpanded } from "./dashboard/useExpanded";
import { useDrilldown } from "./dashboard/useDrilldown";
import { KPI_REGISTRY, KpiRow } from "./dashboard/Kpis";
import { CHART_REGISTRY } from "./dashboard/registry";
import { StripCustomizer } from "./dashboard/StripCustomizer";
import { useDashLayout } from "./dashboard/useDashLayout";
import { arrange } from "./dashboard/layout";

/** Identity-stable "first load hasn't landed yet" tuple for the three range-filtered payloads. */
const NOT_LOADED: [DashOverview | null, DashTimeseries | null, DashBreakdowns | null] = [null, null, null];

export default function Dashboard() {
  const { get, set: setParam, pick } = useQueryState();
  const sources = useLookup<Source[]>("/sources", []);
  // Security summary is global (not source/date filtered), so fetch it once on mount like sources.
  const security = useLookup<SecuritySummary | null>("/security/summary", null);
  const expand = useExpanded();
  const drill = useDrilldown();
  // Which tiles/charts are shown, in what order, and whether the metrics strip is collapsed.
  const { layout, toggle, move, setKpisCollapsed } = useDashLayout();
  const kpiIds = KPI_REGISTRY.map((k) => k.id);
  const chartIds = CHART_REGISTRY.map((c) => c.id);
  const hiddenCharts = new Set(layout.charts.hidden);

  // The three range-filtered payloads load as one unit: a partial dashboard would mix ranges.
  const qs = pick(["source", "from", "to", "bucket"]);
  const s = qs.toString() ? "?" + qs.toString() : "";
  const { data: dash, loading, error } = useAsync(
    () =>
      Promise.all([
        api<DashOverview>("/dashboard/overview" + s),
        api<DashTimeseries>("/dashboard/timeseries" + s),
        api<DashBreakdowns>("/dashboard/breakdowns" + s),
      ]),
    [s],
  );
  const [overview, ts, bd] = dash ?? NOT_LOADED;

  return (
    <div>
      <h1 className="sr-only">Dashboard</h1>
      <div className="filters">
        <select aria-label="Filter by source" value={get("source")} onChange={(e) => setParam({ source: e.target.value })}>
          <option value="">all sources</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label} ({s.session_count})
            </option>
          ))}
        </select>
        <label className="ctl">
          from <input type="date" value={get("from")} onChange={(e) => setParam({ from: e.target.value })} />
        </label>
        <label className="ctl">
          to <input type="date" value={get("to")} onChange={(e) => setParam({ to: e.target.value })} />
        </label>
        <select aria-label="Time bucket" value={get("bucket")} onChange={(e) => setParam({ bucket: e.target.value })}>
          <option value="">bucket: auto{ts ? ` (${ts.bucket})` : ""}</option>
          <option value="day">day</option>
          <option value="week">week</option>
          <option value="month">month</option>
        </select>
      </div>

      <ErrorAlert error={error} />
      {loading && <Loading />}

      {overview && !loading && (
        <>
          <section className="dash-strip">
            <div className="strip-head">
              <h2>Metrics</h2>
              <div className="strip-actions">
                <button
                  type="button"
                  className="link-btn"
                  aria-expanded={!layout.kpisCollapsed}
                  onClick={() => setKpisCollapsed(!layout.kpisCollapsed)}
                >
                  {layout.kpisCollapsed ? "▸ show" : "▾ hide"}
                </button>
                <StripCustomizer
                  label="Metrics"
                  items={arrange(KPI_REGISTRY, layout.kpis.order)}
                  hidden={new Set(layout.kpis.hidden)}
                  onToggle={(id, visible) => toggle("kpis", id, visible)}
                  onMove={(id, dir) => move("kpis", kpiIds, id, dir)}
                />
              </div>
            </div>
            {!layout.kpisCollapsed && <KpiRow ctx={{ overview, bd, security }} layout={layout.kpis} />}
          </section>

          <section className="dash-strip">
            <div className="strip-head">
              <h2>Charts</h2>
              <div className="strip-actions">
                <StripCustomizer
                  label="Charts"
                  items={arrange(CHART_REGISTRY, layout.charts.order)}
                  hidden={hiddenCharts}
                  onToggle={(id, visible) => toggle("charts", id, visible)}
                  onMove={(id, dir) => move("charts", chartIds, id, dir)}
                />
              </div>
            </div>

            {/* Every card renders (each one applies its own `hidden` via ChartCard) rather than being
                filtered out here, so a hidden card keeps its local view state — see ChartProps. */}
            <div className="cards">
              {arrange(CHART_REGISTRY, layout.charts.order).map(({ id, Component }) => (
                <Component key={id} hidden={hiddenCharts.has(id)} ts={ts} bd={bd} expand={expand} drill={drill} />
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
