import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import logoUrl from "./assets/logo.png";
import { api, apiPost, SNAPSHOT } from "./api";
import { useTheme } from "./theme";

/** Compact "3m ago" style label for an ISO8601 instant. */
function relativeTime(iso: string): string {
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default function App() {
  const { theme, toggle } = useTheme();

  // Header freshness readout: when the data was last ingested. Polled so the label (and any
  // background collector run) stays current without a manual reload.
  const [lastIngested, setLastIngested] = useState<string | null>(null);
  // Schema-version drift: the on-disk DB was written by an older build and needs a full re-ingest.
  const [schemaStale, setSchemaStale] = useState(false);
  const refreshStatus = useCallback(() => {
    api<{ last_ingested?: string | null; schema_stale?: boolean }>("/health")
      .then((h) => {
        setLastIngested(h.last_ingested ?? null);
        setSchemaStale(!!h.schema_stale);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshStatus();
    const id = setInterval(refreshStatus, 60_000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  // Manual "refresh data": run collect + ingest on the host, then reload so every view shows the new
  // data. Disabled while running; surfaces "busy" (409) and errors in the button title.
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState<string | null>(null);
  const doRefresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshErr(null);
    try {
      await apiPost("/refresh");
      window.location.reload();
    } catch (e: any) {
      setRefreshErr(String(e?.message ?? e).slice(0, 200));
      setRefreshing(false);
    }
  }, []);
  // Most pages are reading surfaces (transcript, sessions list) and keep a centered, readable column.
  // Layout-heavy pages — the dashboard's chart grid and a skill's body+sessions two-column — opt into
  // a wider container instead (note: "/skills" list stays narrow; only "/skill/<name>" detail widens).
  const { pathname } = useLocation();
  // "/file" (detail) widens like "/skill/<name>"; "/files" (list) stays narrow — exact match only.
  const wide = pathname === "/dashboard" || pathname === "/security" || pathname.startsWith("/skill/") || pathname === "/file";
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Link to="/" className="brand">
          <img src={logoUrl} alt="" className="brand-logo" /> Agent Lens
        </Link>
        <nav className="nav">
          <NavLink to="/" end className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
            Sessions
          </NavLink>
          <NavLink to="/files" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
            Files
          </NavLink>
          <NavLink to="/skills" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
            Skills
          </NavLink>
          <NavLink to="/security" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
            Security
          </NavLink>
          <NavLink to="/dashboard" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
            Dashboard
          </NavLink>
        </nav>
        {lastIngested ? (
          <span className="tagline" title={`Data last ingested ${new Date(lastIngested).toLocaleString()}`}>
            updated {relativeTime(lastIngested)}
          </span>
        ) : (
          <span className="tagline">local agent session explorer</span>
        )}
        <div className="topbar-actions">
          {!SNAPSHOT && (
            <button
              type="button"
              className="ghost refresh-btn"
              onClick={doRefresh}
              disabled={refreshing}
              aria-label="Refresh data — collect new transcripts and rebuild"
              title={
                refreshErr
                  ? `Refresh failed: ${refreshErr}`
                  : "Collect new transcripts and rebuild the data (runs on the host)"
              }
            >
              <span className={refreshing ? "refresh-icon spinning" : "refresh-icon"} aria-hidden="true">
                ⟳
              </span>{" "}
              {refreshing ? "Refreshing…" : refreshErr ? "Retry" : "Refresh"}
            </button>
          )}
          <button
            type="button"
            className="ghost theme-toggle"
            onClick={toggle}
            aria-label="Toggle light or dark theme"
            aria-pressed={theme === "light"}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>
      </header>
      {schemaStale && (
        <div className="schema-banner" role="status">
          ⚠ Data schema is out of date — run <code>agent-lens ingest --full</code> on the host to rebuild.
          The <em>Refresh</em> button only does an incremental ingest and won't fix this.
        </div>
      )}
      <main className={"content" + (wide ? " wide" : "")} id="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
