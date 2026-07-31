import React, { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App";
import SessionsView from "./SessionsView";
import { SNAPSHOT } from "./api";
import { Loading } from "./AsyncBoundary";
import { ThemeProvider } from "./theme";
import "./styles.css";

// Lazy-load the heavier routes so the initial bundle stays small: Dashboard pulls in Recharts
// (the bulk of the bundle), and SessionView the transcript viewer. Both are off the landing path.
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
const basename = ((import.meta as any).env?.BASE_URL ?? "/").replace(/\/$/, "");

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter basename={basename}>
        <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<SessionsView />} />
          <Route
            path="dashboard"
            element={
              <Suspense fallback={<Loading />}>
                <Dashboard />
              </Suspense>
            }
          />
          <Route
            path="session/:id"
            element={
              <Suspense fallback={<Loading />}>
                <SessionView />
              </Suspense>
            }
          />
          <Route
            path="workflow/:run_id"
            element={
              <Suspense fallback={<Loading />}>
                <WorkflowView />
              </Suspense>
            }
          />
          <Route
            path="files"
            element={
              <Suspense fallback={<Loading />}>
                <FilesView />
              </Suspense>
            }
          />
          <Route
            path="file"
            element={
              <Suspense fallback={<Loading />}>
                <FileView />
              </Suspense>
            }
          />
          <Route
            path="skills"
            element={
              <Suspense fallback={<Loading />}>
                <SkillsView />
              </Suspense>
            }
          />
          <Route
            path="skill/:name"
            element={
              <Suspense fallback={<Loading />}>
                <SkillView />
              </Suspense>
            }
          />
          <Route
            path="security"
            element={
              <Suspense fallback={<Loading />}>
                <SecurityView />
              </Suspense>
            }
          />
          {/* Diagnostics (ADR-027). Omitted entirely from a snapshot build: /api/about is not
              exported — it carries absolute filesystem paths and the snapshot is published
              publicly — so the route would render a permanent error. Note check-snapshot-links.mjs
              could NOT catch that, since it follows links in exported payloads, not SPA source. */}
          {!SNAPSHOT && (
            <Route
              path="about"
              element={
                <Suspense fallback={<Loading />}>
                  <AboutView />
                </Suspense>
              }
            />
          )}
        </Route>
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
);
