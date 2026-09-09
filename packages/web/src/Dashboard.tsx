import { api, SNAPSHOT, type DashOverview, type DashTimeseries, type DashBreakdowns, type DashTime, type DashAudit, type SecuritySummary, type Source } from "./api";
import { MultiSelect } from "./MultiSelect";
import { shortModel } from "./format";
import { useAsync, useLookup } from "./useFetch";
import { useQueryState } from "./useQueryState";
import { ErrorAlert, Loading } from "./AsyncBoundary";
import { useExpanded } from "./dashboard/useExpanded";
import { useDrilldown } from "./dashboard/useDrilldown";
import { KPI_REGISTRY, KpiRow } from "./dashboard/Kpis";
import { AUDIT_CHART_IDS, CHART_REGISTRY, TIME_CHART_IDS } from "./dashboard/registry";
import { StripCustomizer } from "./dashboard/StripCustomizer";
import { PresetPills } from "./dashboard/PresetPills";
import { useDashLayout } from "./dashboard/useDashLayout";
import { arrange } from "./dashboard/layout";

// Registry id lists are identity-stable module constants: useDashLayout memoizes the resolved body on
// them, so rebuilding them per render would recompute it every time.
const KPI_IDS = KPI_REGISTRY.map((k) => k.id);
const CHART_IDS = CHART_REGISTRY.map((c) => c.id);

/** Identity-stable "first load hasn't landed yet" tuple for the three range-filtered payloads. */
const NOT_LOADED: [DashOverview | null, DashTimeseries | null, DashBreakdowns | null] = [null, null, null];

export default function Dashboard() {
  const { get, set: setParam, pick } = useQueryState();
  const sources = useLookup<Source[]>("/sources", []);
  // `<synthetic>` marks replies generated without an API call. It carries 0 work tokens, so as a
  // dashboard filter it would be a choice that changes no total — dropped here rather than from
  // /api/models, which the sessions list filters on for real (ADR-035).
  const models = useLookup<string[]>("/models", []).filter((m) => m !== "<synthetic>");
  // Security summary is global (not source/date filtered), so fetch it once on mount like sources.
  const security = useLookup<SecuritySummary | null>("/security/summary", null);
  const expand = useExpanded();
  const drill = useDrilldown();
  // Which view is active, and which tiles/charts it shows, in what order.
  const { layout, active, body, setActive, toggle, move, reset, setKpisCollapsed } = useDashLayout(KPI_IDS, CHART_IDS);
  const hiddenCharts = new Set(body.charts.hidden);

  // The three range-filtered payloads load as one unit: a partial dashboard would mix ranges.
  // An absent `models` param means every model, which is NOT the same query as listing them all:
  // `<synthetic>` is not an option, so an explicit list drops the sessions that only ever replied
  // without an API call, along with every row whose model is unknown (ADR-035). So the param is
  // written only while the selection is a genuine narrowing, and read back as "all" when absent.
  const pickedModels = get("models").split(",").filter(Boolean);
  const selectedModels = pickedModels.length ? pickedModels : models;
  const qs = pick(["source", "from", "to", "bucket", "models"]);
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
  // The date inputs are already local calendar days, which is exactly the grain the burn heatmap
  // normalizes over — so they travel to the cards as typed, with no zone conversion in between.
  const range = { from: get("from"), to: get("to") };

  // The time analytics load on their own, NOT as a fourth entry in the Promise.all above: they are
  // several heavier aggregates, and folding them in would mean one slow or failing query blanking
  // the whole dashboard. Skipped entirely while every tile that reads them is hidden — the flag is
  // in the dep key, so un-hiding one fires the request.
  const timeVisible = TIME_CHART_IDS.some((id) => !hiddenCharts.has(id));
  const { data: time, error: timeError } = useAsync(() => (timeVisible ? api<DashTime>("/dashboard/time" + s) : null), [s, timeVisible]);
  // Same arrangement for the audit tiles, and separate from `time` for the same reason they are
  // separate from the Promise.all: one endpoint failing should cost its own four cards, not the rest.
  const auditVisible = AUDIT_CHART_IDS.some((id) => !hiddenCharts.has(id));
  const { data: audit, error: auditError } = useAsync(() => (auditVisible ? api<DashAudit>("/dashboard/audit" + s) : null), [s, auditVisible]);

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
        <MultiSelect
          label="Models"
          options={models.map((m) => ({ value: m, label: shortModel(m) }))}
          selected={selectedModels}
          onChange={(next) => setParam({ models: next.length === models.length ? "" : next.join(",") })}
          reset={{ label: "select all", to: models }}
          disabled={SNAPSHOT}
          tip={
            SNAPSHOT
              ? "The exported demo serves one pre-computed view, so filters do not apply to it."
              : "Applies to every chart. Spend, turns and tool calls filter on the model that produced them; anything counted per session counts sessions that used one of these."
          }
        />
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
      <ErrorAlert error={timeError} />
      <ErrorAlert error={auditError} />
      {loading && <Loading />}

      {overview && !loading && (
        <>
          <PresetPills active={active} hasCustom={layout.custom != null} onSelect={setActive} />

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
                  items={arrange(KPI_REGISTRY, body.kpis.order)}
                  hidden={new Set(body.kpis.hidden)}
                  onToggle={(id, visible) => toggle("kpis", id, visible)}
                  onMove={(id, dir) => move("kpis", KPI_IDS, id, dir)}
                  onReset={() => reset("kpis")}
                />
              </div>
            </div>
            {!layout.kpisCollapsed && <KpiRow ctx={{ overview, bd, security }} layout={body.kpis} />}
          </section>

          <section className="dash-strip">
            <div className="strip-head">
              <h2>Charts</h2>
              <div className="strip-actions">
                <StripCustomizer
                  label="Charts"
                  items={arrange(CHART_REGISTRY, body.charts.order)}
                  hidden={hiddenCharts}
                  onToggle={(id, visible) => toggle("charts", id, visible)}
                  onMove={(id, dir) => move("charts", CHART_IDS, id, dir)}
                  onReset={() => reset("charts")}
                />
              </div>
            </div>

            {/* Every card renders (each one applies its own `hidden` via ChartCard) rather than being
                filtered out here, so a hidden card keeps its local view state — see ChartProps. */}
            <div className="cards">
              {arrange(CHART_REGISTRY, body.charts.order).map(({ id, Component }) => (
                <Component key={id} hidden={hiddenCharts.has(id)} ts={ts} bd={bd} time={time} audit={audit} expand={expand} drill={drill} range={range} />
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
