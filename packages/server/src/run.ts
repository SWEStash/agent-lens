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
import { findRepoRoot, resolveDataDir, resolveWebDist } from "@agent-lens/core";
import { openReadonly } from "./db.js";
import { createApp } from "./app.js";

export async function startServer(): Promise<void> {
  // Resolve relative to this module: in dev it's packages/server/dist; bundled into the CLI it's the
  // published package root (web SPA sits at ../web, data falls back to the per-user dir).
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(here);
  const dbPath = process.env.AGENT_LENS_DB || join(resolveDataDir(repoRoot), "agent-lens.db");
  const host = process.env.AGENT_LENS_HOST || "127.0.0.1"; // loopback only by default
  const port = Number(process.env.AGENT_LENS_PORT || 4477);
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

  const db = openReadonly(dbPath);
  const app = await createApp(db, { webDist });

  try {
    await app.listen({ host, port });
    console.log(`agent-lens-server: http://${host}:${port}  (db: ${dbPath})`);
    if (!existsSync(webDist)) console.log("  note: web SPA not built — run `pnpm --filter @agent-lens/web build`");
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
