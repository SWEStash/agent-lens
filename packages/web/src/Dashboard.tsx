import { useEffect, useState } from "react";
import { api, type DashOverview, type DashTimeseries, type DashBreakdowns, type SecuritySummary, type Source } from "./api";
import { useAsync, useLookup } from "./useFetch";
import { useQueryState } from "./useQueryState";
import { ErrorAlert, Loading } from "./AsyncBoundary";
import { loadPrefLocal, fetchPref, savePref } from "./prefs";
import { useExpanded } from "./dashboard/useExpanded";
import { useDrilldown } from "./dashboard/useDrilldown";
import { KpiRow } from "./dashboard/Kpis";
import { CHART_REGISTRY, CHARTS_PREF_KEY, ChartCustomizer } from "./dashboard/registry";

/** Identity-stable "first load hasn't landed yet" tuple for the three range-filtered payloads. */
const NOT_LOADED: [DashOverview | null, DashTimeseries | null, DashBreakdowns | null] = [null, null, null];

export default function Dashboard() {
  const { get, set: setParam, pick } = useQueryState();
  const sources = useLookup<Source[]>("/sources", []);
  // Security summary is global (not source/date filtered), so fetch it once on mount like sources.
  const security = useLookup<SecuritySummary | null>("/security/summary", null);
  const expand = useExpanded();
  const drill = useDrilldown();
  // Hidden chart ids (persisted). Paint from localStorage, then reconcile with the server pref.
  const [hiddenCharts, setHiddenCharts] = useState<Set<string>>(() => new Set(loadPrefLocal<string[]>(CHARTS_PREF_KEY, [])));
  useEffect(() => {
    fetchPref<string[]>(CHARTS_PREF_KEY).then((v) => v && setHiddenCharts(new Set(v)));
  }, []);
  const toggleChart = (id: string, visible: boolean) =>
    setHiddenCharts((prev) => {
      const next = new Set(prev);
      if (visible) next.delete(id);
      else next.add(id);
      savePref(CHARTS_PREF_KEY, [...next]);
      return next;
    });

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
          <KpiRow overview={overview} bd={bd} security={security} />

          <div className="dash-toolbar">
            <ChartCustomizer hidden={hiddenCharts} onToggle={toggleChart} />
          </div>

          {/* Every card renders (each one applies its own `hidden` via ChartCard) rather than being
              filtered out here, so a hidden card keeps its local view state — see ChartProps. */}
          <div className="cards">
            {CHART_REGISTRY.map(({ id, Component }) => (
              <Component key={id} hidden={hiddenCharts.has(id)} ts={ts} bd={bd} expand={expand} drill={drill} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
