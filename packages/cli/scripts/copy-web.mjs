// Copy the built web SPA into the CLI package so it ships inside the published tarball. The server
// (bundled into dist/agent-lens.js) resolves it at runtime via `<pkgDir>/web` (resolveWebDist).
// Uses fs.cp (no `cp -r`) so it works on Windows too. Runs after tsup in the CLI `build` script.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webDist = resolve(pkgRoot, "../web/dist");
const dest = join(pkgRoot, "web");

if (!existsSync(webDist)) {
  console.error(`copy-web: ${webDist} not found — build the web package first (pnpm --filter @agent-lens/web build)`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(webDist, dest, { recursive: true });
// Drop the static Pages demo snapshot if a local Pages build left it in web/dist — the runtime
// server serves the live API, never these JSON fixtures, so they're pure weight in the npm tarball.
rmSync(join(dest, "snapshot"), { recursive: true, force: true });
console.log(`copy-web: copied web SPA → ${dest}`);
