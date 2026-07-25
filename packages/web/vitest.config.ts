import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// packages/web is the one package whose tests import *source* rather than a built dist, so vite
// resolves them — and the hook/component tests (`*.test.tsx`) need a DOM. One jsdom environment for
// the whole package keeps a single config: the pure transcript-logic tests don't need the DOM, but
// they don't mind it either, and the alternative is two configs that can drift.
//
// The root vitest.config.ts references this file as a project, so `pnpm test` (whole repo) and
// `pnpm --filter @agent-lens/web test` (this package alone) run web's tests identically.
export default defineConfig({
  plugins: [react()],
  test: {
    name: "web",
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
