#!/usr/bin/env node
/**
 * Thin CLI shim over @agent-lens/core's source resolver — the single source of truth now lives in
 * packages/core/src/sources.ts. Kept so the (still-bash) collect.sh and dev scripts can emit the
 * resolved sources as TSV; the Node collector replaces this shim in a later step.
 *
 *   node scripts/sources.mjs              # one `label<TAB>agent<TAB>configDir` line per source
 *   node scripts/sources.mjs --excludes   # resolved exclude paths, one per line
 *
 * Requires the workspace to be built (packages/core/dist), same as ingest.sh / serve.sh.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const core = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/core/dist/index.js");
if (!existsSync(core)) {
  console.error("agent-lens: core is not built (packages/core/dist missing) — run 'pnpm build' first");
  process.exit(1);
}
const { loadSources, loadExcludes } = await import(core);

if (process.argv.includes("--excludes")) {
  for (const p of loadExcludes()) process.stdout.write(p + "\n");
} else {
  for (const s of loadSources()) process.stdout.write(`${s.label}\t${s.agent}\t${s.configDir}\n`);
}
