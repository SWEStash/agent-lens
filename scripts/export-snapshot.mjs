#!/usr/bin/env node
/**
 * Export a static, read-only API snapshot from the committed corpus, so the web SPA can be published
 * (e.g. GitHub Pages) with NO live server and NO real data.
 *
 * Recipe (identical launch to scripts/sandbox.sh): ingest the 3-source corpus (team-a, team-b =
 * redacted real; scenarios = synthetic) into an isolated temp DB, start the read-only server, then
 * crawl every endpoint the SPA fetches and write each default (unfiltered) response to
 * packages/web/public/snapshot/<path>.json. `packages/web/src/api.ts` reads these when built with
 * VITE_SNAPSHOT=1. Query-driven filters/pagination collapse to the default view (documented).
 *
 * Usage: node scripts/export-snapshot.mjs   (requires `pnpm build` to have produced dist/)
 * Output is corpus-only and reproducible; safe to publish.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = join(REPO, "test/fixtures/corpus");
const OUT = join(REPO, "packages/web/public/snapshot");
const PORT = Number(process.env.AGENT_LENS_PORT || 14488);
const BASE = `http://127.0.0.1:${PORT}`;

if (!existsSync(join(REPO, "packages/ingest/dist/index.js"))) {
  console.error("export-snapshot: dist not found — run `pnpm build` first");
  process.exit(1);
}

const SBX = mkdtempSync(join(tmpdir(), "al-snapshot."));
const env = {
  ...process.env,
  AGENT_LENS_DATA: SBX,
  AGENT_LENS_ARCHIVE: CORPUS,
  AGENT_LENS_DB: join(SBX, "snapshot.db"),
  AGENT_LENS_CONFIG: join(SBX, "sources.json"),
  AGENT_LENS_PORT: String(PORT),
};
writeFileSync(
  env.AGENT_LENS_CONFIG,
  JSON.stringify({
    sources: [
      // Demo/Pages uses ONLY the synthetic, readable `scenarios` source — never the redacted-real
      // team-a/team-b (which exist purely to validate the redaction oracle and would show "[redacted]").
      { label: "scenarios", agent: "claude-code", configDir: "/unused-in-ingest" },
    ],
  }),
);

const run = (cmd, args, opts = {}) =>
  new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: "inherit", env, cwd: REPO, ...opts });
    p.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
    p.on("error", rej);
  });

let server;
function cleanup() {
  if (server) try { server.kill(); } catch { /* ignore */ }
  rmSync(SBX, { recursive: true, force: true });
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

async function getJson(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json();
}
async function getText(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.text();
}
/** Write to snapshot/<rel> — `rel` mirrors the client's resolved path (see api.ts resolveUrl). */
function writeSnap(rel, data) {
  const dest = join(OUT, rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, typeof data === "string" ? data : JSON.stringify(data));
}

async function waitForHealth() {
  for (let i = 0; i < 100; i++) {
    try { if ((await getJson("/api/health")).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become healthy");
}

async function main() {
  console.log("export-snapshot: ingesting corpus --full into", env.AGENT_LENS_DB);
  await run("node", ["packages/ingest/dist/index.js", "--full"]);

  rmSync(OUT, { recursive: true, force: true });

  server = spawn("node", ["packages/server/dist/index.js"], { stdio: "ignore", env, cwd: REPO });
  await waitForHealth();

  // Fixed (unfiltered) endpoints the SPA fetches. Keys are the client path passed to api(); values
  // are the snapshot file rel-path (= path with query stripped + ".json"). Keep in sync with api.ts.
  writeSnap("health.json", await getJson("/api/health"));
  writeSnap("sources.json", await getJson("/api/sources"));
  writeSnap("projects.json", await getJson("/api/projects"));
  writeSnap("models.json", await getJson("/api/models"));
  writeSnap("dashboard/overview.json", await getJson("/api/dashboard/overview"));
  writeSnap("dashboard/timeseries.json", await getJson("/api/dashboard/timeseries"));
  writeSnap("dashboard/breakdowns.json", await getJson("/api/dashboard/breakdowns"));

  // Security findings (ADR-017): the summary + the full findings list. In snapshot mode api.ts strips
  // the query, so the list collapses to one default file — limit=1000 keeps every finding in it (the
  // demo corpus has few, well under a page).
  writeSnap("security/summary.json", await getJson("/api/security/summary"));
  writeSnap("security/findings.json", await getJson("/api/security/findings?limit=1000"));
  writeSnap("security/mutes.json", await getJson("/api/security/mutes")); // empty in the demo; keeps the GET from 404ing

  // Skills list + one detail page per fired skill (api.ts resolves /skills/<name> →
  // snapshot/skills/<name>.json; encode the name to match the client fetch path exactly).
  const skills = await getJson("/api/skills");
  writeSnap("skills.json", skills);
  for (const sk of skills) {
    writeSnap(`skills/${encodeURIComponent(sk.name)}.json`, await getJson(`/api/skills/${encodeURIComponent(sk.name)}`));
  }

  // Sessions list (default view = main sessions). limit covers the whole corpus so there is no
  // pagination to fake; the static list is the complete default page. Shape: { total, sessions }.
  const mainList = await getJson("/api/sessions?kind=main&limit=1000");
  writeSnap("sessions.json", mainList);

  // Every session detail + Markdown export (main AND subagent, so parent/child links resolve).
  const subList = await getJson("/api/sessions?kind=subagent&limit=1000");
  const ids = [...mainList.sessions, ...subList.sessions].map((s) => s.id);
  const runIds = new Set();
  for (const id of ids) {
    const detail = await getJson(`/api/sessions/${encodeURIComponent(id)}`);
    writeSnap(`sessions/${id}.json`, detail);
    writeSnap(`sessions/${id}.export.md`, await getText(`/api/sessions/${encodeURIComponent(id)}/export.md`));
    for (const r of detail.workflow_runs ?? []) if (r.run_id) runIds.add(r.run_id);
  }

  // Workflow detail pages: one per distinct run launched across the corpus (api.ts resolves
  // /workflows/<id> → snapshot/workflows/<id>.json).
  for (const runId of runIds) {
    writeSnap(`workflows/${runId}.json`, await getJson(`/api/workflows/${encodeURIComponent(runId)}`));
  }

  writeSnap("manifest.json", {
    generated_from: "test/fixtures/corpus",
    sources: (await getJson("/api/sources")).map((s) => s.label ?? s.id),
    sessions: ids.length,
    note: "Static corpus-only snapshot — filters/pagination collapse to the default view.",
  });

  console.log(`export-snapshot: wrote ${ids.length} sessions + ${runIds.size} workflows + dashboards to ${OUT}`);
}

main()
  .then(() => { cleanup(); process.exit(0); })
  .catch((err) => {
    console.error("export-snapshot failed:", err.message);
    process.exit(1);
  });
