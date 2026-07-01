import { defineConfig } from "tsup";

// Bundle the whole CLI (including the pure-JS workspace packages + cac) into one ESM file, leaving
// only the native / heavy runtime deps external so npm's install resolves the platform-correct
// binaries. See ADR-010 (single-CLI distribution).
export default defineConfig({
  entry: { "agent-lens": "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node24",
  bundle: true,
  // Inline the workspace code (their `workspace:*` versions can't be published) + the tiny CLI parser.
  noExternal: [/^@agent-lens\//, "cac"],
  // Keep native + framework deps external — resolved from node_modules at runtime.
  external: ["better-sqlite3", "fastify", "@fastify/static", "chokidar"],
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
  sourcemap: true,
  dts: false,
});
