import { Link, Outlet } from "react-router-dom";

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          🔎 Agent Lens
        </Link>
        <span className="tagline">local agent session explorer</span>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
