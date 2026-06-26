import { Link, NavLink, Outlet } from "react-router-dom";

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          🔎 Agent Lens
        </Link>
        <nav className="nav">
          <NavLink to="/" end className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
            Sessions
          </NavLink>
          <NavLink to="/dashboard" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
            Dashboard
          </NavLink>
        </nav>
        <span className="tagline">local agent session explorer</span>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
