#!/usr/bin/env node
/**
 * Agent Lens — Stage 3 local server (ADR-005: 127.0.0.1 only, no egress).
 *
 * Read-only REST over the SQLite store + Markdown export, and serves the built web SPA.
 * Usage: agent-lens-server   (env: AGENT_LENS_DB, AGENT_LENS_PORT, AGENT_LENS_HOST)
 *
 * The route tree lives in app.ts (`createApp`); this file is just the CLI bootstrap.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openReadonly } from "./db.js";
import { createApp } from "./app.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dbPath = process.env.AGENT_LENS_DB || join(process.env.AGENT_LENS_DATA || join(repoRoot, "data"), "agent-lens.db");
const host = process.env.AGENT_LENS_HOST || "127.0.0.1"; // loopback only by default
const port = Number(process.env.AGENT_LENS_PORT || 4477);
const webDist = join(repoRoot, "packages/web/dist");

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

app
  .listen({ host, port })
  .then(() => {
    console.log(`agent-lens-server: http://${host}:${port}  (db: ${dbPath})`);
    if (!existsSync(webDist)) console.log("  note: web SPA not built — run `pnpm --filter @agent-lens/web build`");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
