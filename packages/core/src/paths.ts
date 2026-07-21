/**
 * Path resolution shared by ingest, server, and the CLI. The goal is that agent-lens works both
 * from the dev monorepo (data under <repo>/data, config at the repo root) AND when installed as a
 * standalone package under node_modules (per-user OS data dir, no repo layout to assume).
 *
 * Nothing here reads process state beyond env vars + the filesystem, so it is safe to call from any
 * entrypoint. `import.meta.url`-relative resolution replaces the old hardcoded "../../.." repo anchor.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";

/** Expand a leading `~` or `$HOME` and resolve to an absolute path. Empty input passes through. */
export function expandPath(p: string): string {
  if (!p) return p;
  let out = p;
  if (out === "~") out = homedir();
  else if (out.startsWith("~/")) out = join(homedir(), out.slice(2));
  out = out.replace(/\$HOME/g, homedir());
  return resolve(out);
}

const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * Find the agent-lens monorepo root by walking up from `from` (default: this module's location).
 * A directory qualifies only if it has BOTH a `pnpm-workspace.yaml` AND a `package.json` named
 * "agent-lens" — so an unrelated pnpm workspace never matches, and the published/bundled package
 * (which ships neither) resolves to `null`, sending data to the per-user dir instead.
 */
export function findRepoRoot(from: string = moduleDir): string | null {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (pkg?.name === "agent-lens") return dir;
      } catch {
        /* not the file we want — keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Per-user data directory used when not running from the repo (installed CLI). */
export function userDataDir(): string {
  const home = homedir();
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "agent-lens");
  }
  if (platform() === "darwin") {
    return join(home, "Library", "Application Support", "agent-lens");
  }
  return join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "agent-lens");
}

/** The data dir: `AGENT_LENS_DATA` → `<repo>/data` (dev) → per-user OS dir (installed). */
export function resolveDataDir(repoRoot: string | null = findRepoRoot()): string {
  if (process.env.AGENT_LENS_DATA) return resolve(process.env.AGENT_LENS_DATA);
  if (repoRoot) return join(repoRoot, "data");
  return userDataDir();
}

/**
 * The raw transcript mirror, always `<dataDir>/archive` (ADR-021). Deliberately not independently
 * configurable: it is the source of truth, so a stray override desyncs the writer (collect) from the
 * readers (ingest, refresh) and silently strands previously collected data. Move the data dir instead.
 */
export function resolveArchiveDir(repoRoot: string | null = findRepoRoot()): string {
  return join(resolveDataDir(repoRoot), "archive");
}

/**
 * The writable triage/prefs sidecar (ADR-018) for a given store: `triage.db` beside it. Also fixed
 * (ADR-021) — it holds hand-authored state that nothing can rebuild, so it travels with the db it
 * annotates rather than taking an override of its own.
 */
export function triageDbFor(dbPath: string): string {
  return join(dirname(dbPath), "triage.db");
}

/**
 * First existing config file, in precedence order:
 *   `AGENT_LENS_CONFIG` → `<dataDir>/agent-lens.config.json` → repo config → repo example.
 * Returns `null` when none exist (callers fall back to the built-in default source).
 */
export function resolveConfigFile(repoRoot: string | null, dataDir: string): string | null {
  const candidates = [
    process.env.AGENT_LENS_CONFIG,
    join(dataDir, "agent-lens.config.json"),
    repoRoot ? join(repoRoot, "agent-lens.config.json") : null,
    repoRoot ? join(repoRoot, "agent-lens.config.example.json") : null,
  ].filter((x): x is string => Boolean(x));
  for (const f of candidates) if (existsSync(f)) return f;
  return null;
}

/**
 * The built web SPA directory. Tries, in order: the bundled layout (`<pkgDir>/web`, a sibling of the
 * CLI's `dist/`), the dev sibling (`packages/server/dist` → `packages/web/dist`), then the repo path.
 * `fromDir` is the directory of the calling module (`dirname(fileURLToPath(import.meta.url))`).
 */
export function resolveWebDist(fromDir: string, repoRoot: string | null = findRepoRoot(fromDir)): string {
  const installed = resolve(fromDir, "../web"); // bundled CLI: dist/ and web/ are siblings
  if (existsSync(installed)) return installed;
  const devSibling = resolve(fromDir, "../../web/dist"); // packages/server/dist → packages/web/dist
  if (existsSync(devSibling)) return devSibling;
  if (repoRoot) return join(repoRoot, "packages/web/dist");
  return installed; // best-effort default; caller guards with existsSync
}
