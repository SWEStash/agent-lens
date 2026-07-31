/**
 * Shared launch recipe for the corpus-backed sandbox server (same shape as scripts/sandbox.sh, which
 * stays a separate bash implementation for interactive use).
 *
 * export-snapshot.mjs and screenshots.mjs both need the identical sequence: an isolated temp dir, a
 * sources.json naming ONLY the synthetic `scenarios` source, an ingest of the committed corpus into a
 * throwaway DB, then the read-only server on a private port — with the sandbox removed and the server
 * killed on every exit path. That was ~45 duplicated lines and had already drifted between the two.
 *
 * What legitimately differs (temp prefix, DB filename, port, extra env) is a parameter; what does not
 * lives here once.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CORPUS = join(REPO, "test/fixtures/corpus");

/**
 * Poll /api/health until the server answers ok (10s: 100 tries × 100ms). Callers await this before
 * issuing the first real request — the server needs a moment to open the DB and bind.
 */
export async function waitForHealth(base) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await (await fetch(base + "/api/health")).json()).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become healthy");
}

/**
 * Create the sandbox (temp dir + env + sources.json) and register its teardown. Returns the pieces
 * the caller drives: `env` for child processes, `BASE` for fetches, `run()` to await a build/ingest
 * step, `startServer()` to spawn the server, and `cleanup()` for the caller's own exit path.
 *
 * @param {object} o
 * @param {string} o.prefix   mkdtemp prefix, e.g. "al-snapshot."
 * @param {string} o.dbName   DB filename inside the sandbox, e.g. "snapshot.db"
 * @param {number} o.port     private port for this run
 * @param {Record<string,string>} [o.env]  extra env (e.g. VITE_SNAPSHOT to force a live web build)
 */
export function createCorpusSandbox({ prefix, dbName, port, env: extraEnv = {} }) {
  const SBX = mkdtempSync(join(tmpdir(), prefix));
  const BASE = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    AGENT_LENS_DATA: SBX,
    AGENT_LENS_DB: join(SBX, dbName),
    AGENT_LENS_CONFIG: join(SBX, "sources.json"),
    AGENT_LENS_PORT: String(port),
    ...extraEnv,
  };

  writeFileSync(
    env.AGENT_LENS_CONFIG,
    JSON.stringify({
      sources: [
        // Demo/Pages output uses ONLY the synthetic, readable `scenarios` source — never the
        // redacted-real team-a/team-b (which exist purely to validate the redaction oracle and
        // would render as "[redacted]").
        { label: "scenarios", agent: "claude-code", configDir: "/unused-in-ingest" },
      ],
    }),
  );

  let server;
  function cleanup() {
    if (server) try { server.kill(); } catch { /* already gone */ }
    rmSync(SBX, { recursive: true, force: true });
  }
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });

  const run = (cmd, args, opts = {}) =>
    new Promise((res, rej) => {
      const p = spawn(cmd, args, { stdio: "inherit", env, cwd: REPO, ...opts });
      p.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} ${args.join(" ")} → ${code}`))));
      p.on("error", rej);
    });

  const startServer = () => {
    server = spawn("node", ["packages/server/dist/index.js"], { stdio: "ignore", env, cwd: REPO });
    return server;
  };

  return { SBX, BASE, env, run, startServer, cleanup };
}
