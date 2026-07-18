/**
 * Agent Lens — Stage 3 local server, as an importable function (ADR-005: 127.0.0.1 only, no egress).
 *
 * `startServer` is the library entrypoint so the unified `agent-lens` CLI can bundle and call it
 * in-process; the thin bin in index.ts just forwards to it. Read-only REST over the SQLite store +
 * Markdown export, and serves the built web SPA. (env: AGENT_LENS_DB, AGENT_LENS_PORT, AGENT_LENS_HOST)
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot, resolveDataDir, resolveServerConfig, resolveWebDist } from "@agent-lens/core";
import { openReadonly } from "./db.js";
import { createApp } from "./app.js";

// Re-exported for the unified CLI (bundles this package): the read-only DB open + the shared
// session-export helpers back the `agent-lens export` command without a second server process.
export { openReadonly } from "./db.js";
export { renderSessionExport, parseRedactionLevel } from "./export.js";

/** Per-invocation overrides (from `serve --port/--host/--db`); each takes precedence over env + file. */
export interface StartServerOverrides {
  port?: number | string;
  host?: string;
  db?: string;
}

export async function startServer(overrides: StartServerOverrides = {}): Promise<void> {
  // Resolve relative to this module: in dev it's packages/server/dist; bundled into the CLI it's the
  // published package root (web SPA sits at ../web, data falls back to the per-user dir).
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(here);
  const dbPath = overrides.db || process.env.AGENT_LENS_DB || join(resolveDataDir(repoRoot), "agent-lens.db");
  // Port/host resolve with precedence flag > env > file > default, validated (bad port fails fast).
  const { host, port } = resolveServerConfig({ port: overrides.port, host: overrides.host });
  const webDist = resolveWebDist(here, repoRoot);

  if (host !== "127.0.0.1" && host !== "localhost" && !process.env.AGENT_LENS_ALLOW_NONLOCAL) {
    console.error(
      `agent-lens-server: refusing to bind non-loopback host '${host}' (privacy). ` +
        `Set AGENT_LENS_ALLOW_NONLOCAL=1 to override.`,
    );
    process.exit(1);
  }
  if (!existsSync(dbPath)) {
    console.error(`agent-lens-server: db not found: ${dbPath} (run ingest first)`);
    process.exit(1);
  }

  // Triage store (ADR-018) sits beside the analytics DB and is never touched by ingest, so user triage
  // survives `ingest --full`. Opened read-write by createApp; the analytics handle stays read-only.
  const triageDbPath = process.env.AGENT_LENS_TRIAGE_DB || join(dirname(dbPath), "triage.db");

  const db = openReadonly(dbPath);
  // Enforce a loopback Host allowlist (DNS-rebinding defense) whenever we're bound to loopback. An
  // intentional non-loopback bind (host set + AGENT_LENS_ALLOW_NONLOCAL, checked above) opts out.
  const enforceLoopbackHost = host === "127.0.0.1" || host === "localhost";
  const app = await createApp(db, { webDist, triageDbPath, enforceLoopbackHost });

  try {
    await app.listen({ host, port });
    console.log(`agent-lens-server: http://${host}:${port}  (db: ${dbPath})`);
    if (!existsSync(webDist)) console.log("  note: web SPA not built — run `pnpm --filter @agent-lens/web build`");
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
