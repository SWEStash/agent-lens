import { Link, NavLink, Outlet, useLocation } from "react-router-dom";

export default function App() {
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
          🔎 Agent Lens
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
        <span className="tagline">local agent session explorer</span>
      </header>
      <main className={"content" + (wide ? " wide" : "")} id="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
