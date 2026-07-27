import { copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.AGENT_LENS_API || "http://127.0.0.1:4477";

/**
 * SPA deep-link fallback for static hosts (GitHub Pages).
 *
 * The app uses BrowserRouter, so a route like /agent-lens/security or /agent-lens/file?path=… is a
 * real URL the browser requests from the host on a fresh load or an F5 — but the only HTML file the
 * build emits is index.html, so a static host answers every deep path with its own 404 page. GitHub
 * Pages serves 404.html for unmatched paths, so shipping a byte-identical copy of index.html under
 * that name makes it the SPA fallback: the router boots and resolves the route client-side, with the
 * URL preserved exactly (unlike the redirect-based spa-github-pages hack).
 *
 * Harmless elsewhere: the CLI's loopback server has its own SPA fallback and never serves this file.
 */
function spaFallback(): Plugin {
  return {
    name: "agent-lens:spa-404-fallback",
    apply: "build",
    closeBundle() {
      const out = resolve(__dirname, "dist");
      copyFileSync(resolve(out, "index.html"), resolve(out, "404.html"));
    },
  };
}

export default defineConfig({
  plugins: [react(), spaFallback()],
  // Served at "/" locally and by the loopback server; GitHub Pages hosts under a repo subpath, so the
  // Pages build sets VITE_BASE (e.g. "/agent-lens/"). Trailing slash matters for asset URLs.
  base: process.env.VITE_BASE || "/",
  server: {
    port: 5173,
    proxy: { "/api": apiTarget },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
