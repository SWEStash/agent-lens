import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.AGENT_LENS_API || "http://127.0.0.1:4477";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": apiTarget },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
