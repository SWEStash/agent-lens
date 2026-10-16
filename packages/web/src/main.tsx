import React, { lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App";
import SessionsView from "./SessionsView";
import { SNAPSHOT } from "./api";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { ThemeProvider } from "./theme";
import "./styles.css";

// Lazy-load every route but the landing session list so the initial bundle stays small — Dashboard
// alone pulls in Recharts, the bulk of the bundle. App wraps its <Outlet/> in the one Suspense.
const Dashboard = lazy(() => import("./Dashboard"));
const SessionView = lazy(() => import("./SessionView"));
const WorkflowView = lazy(() => import("./WorkflowView"));
const SkillsView = lazy(() => import("./SkillsView"));
const SkillView = lazy(() => import("./SkillView"));
const FilesView = lazy(() => import("./FilesView"));
const FileView = lazy(() => import("./FileView"));
const SecurityView = lazy(() => import("./SecurityView"));
const AboutView = lazy(() => import("./AboutView"));

// Under GitHub Pages the app is served from a repo subpath (Vite's BASE_URL, e.g. "/agent-lens/");
// the router basename keeps client routes working there. "/" → "" (no basename) for local serving.
const basename = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <AppErrorBoundary>
        <BrowserRouter basename={basename}>
          <Routes>
            <Route path="/" element={<App />}>
              <Route index element={<SessionsView />} />
              <Route path="dashboard" element={<Dashboard />} />
              <Route path="session/:id" element={<SessionView />} />
              <Route path="workflow/:run_id" element={<WorkflowView />} />
              <Route path="files" element={<FilesView />} />
              <Route path="file" element={<FileView />} />
              <Route path="skills" element={<SkillsView />} />
              <Route path="skill/:name" element={<SkillView />} />
              <Route path="security" element={<SecurityView />} />
              {/* Diagnostics (ADR-027). Omitted entirely from a snapshot build: /api/about is not
                  exported — it carries absolute filesystem paths and the snapshot is published
                  publicly — so the route would render a permanent error. Note check-snapshot-links.mjs
                  could NOT catch that, since it follows links in exported payloads, not SPA source. */}
              {!SNAPSHOT && <Route path="about" element={<AboutView />} />}
            </Route>
          </Routes>
        </BrowserRouter>
      </AppErrorBoundary>
    </ThemeProvider>
  </React.StrictMode>,
);
