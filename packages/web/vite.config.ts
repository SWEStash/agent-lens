import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.AGENT_LENS_API || "http://127.0.0.1:4477";

export default defineConfig({
  plugins: [react()],
  // Served at "/" locally and by the loopback server; GitHub Pages hosts under a repo subpath, so the
  // Pages build sets VITE_BASE (e.g. "/agent-lens/"). Trailing slash matters for asset URLs.
  base: process.env.VITE_BASE || "/",
  server: {
    port: 5173,
    proxy: { "/api": apiTarget },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
