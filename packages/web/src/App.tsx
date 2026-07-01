import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import logoUrl from "./assets/logo.png";
import { api } from "./api";
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
  const refreshStatus = useCallback(() => {
    api<{ last_ingested?: string | null }>("/health")
      .then((h) => setLastIngested(h.last_ingested ?? null))
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshStatus();
    const id = setInterval(refreshStatus, 60_000);
    return () => clearInterval(id);
  }, [refreshStatus]);
  // Most pages are reading surfaces (transcript, sessions list) and keep a centered, readable column.
  // Layout-heavy pages — the dashboard's chart grid and a skill's body+sessions two-column — opt into
  // a wider container instead (note: "/skills" list stays narrow; only "/skill/<name>" detail widens).
  const { pathname } = useLocation();
  const wide = pathname === "/dashboard" || pathname.startsWith("/skill/");
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
          <NavLink to="/skills" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
            Skills
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
      </header>
      <main className={"content" + (wide ? " wide" : "")} id="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
