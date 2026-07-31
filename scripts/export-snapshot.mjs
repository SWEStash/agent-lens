#!/usr/bin/env node
/**
 * Export a static, read-only API snapshot from the committed corpus, so the web SPA can be published
 * (e.g. GitHub Pages) with NO live server and NO real data.
 *
 * Recipe (launch shared with screenshots.mjs via scripts/lib/sandbox.mjs): ingest the corpus (team-a,
 * team-b =
 * redacted real; scenarios = synthetic) into an isolated temp DB, start the read-only server, then
 * crawl every endpoint the SPA fetches and write each default (unfiltered) response to
 * packages/web/public/snapshot/<path>.json. `packages/web/src/api.ts` reads these when built with
 * VITE_SNAPSHOT=1. Query-driven filters/pagination collapse to the default view (documented).
 *
 * Usage: node scripts/export-snapshot.mjs   (requires `pnpm build` to have produced dist/)
 * Output is corpus-only and reproducible; safe to publish.
 */
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createCorpusSandbox, waitForHealth, REPO, CORPUS } from "./lib/sandbox.mjs";

const OUT = join(REPO, "packages/web/public/snapshot");
const PORT = Number(process.env.AGENT_LENS_PORT || 14488);

if (!existsSync(join(REPO, "packages/ingest/dist/index.js"))) {
  console.error("export-snapshot: dist not found — run `pnpm build` first");
  process.exit(1);
}

const { BASE, env, run, startServer, cleanup } = createCorpusSandbox({
  prefix: "al-snapshot.",
  dbName: "snapshot.db",
  port: PORT,
});

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
/**
 * Stable snapshot key for a file's provenance timeline (/file). Mirror of snapshotFileKey in
 * packages/web/src/api.ts — the SPA computes the identical key to fetch snapshot/file/<key>.json, so
 * KEEP THE TWO IN SYNC (change one, change the other). cyrb53 over `${project}\n${path}`.
 */
function snapshotFileKey(path, project) {
  const s = `${project ?? ""}\n${path}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Write to snapshot/<rel> — `rel` mirrors the client's resolved path (see api.ts resolveUrl). */
function writeSnap(rel, data) {
  const dest = join(OUT, rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, typeof data === "string" ? data : JSON.stringify(data));
}

async function main() {
  console.log("export-snapshot: ingesting corpus --full into", env.AGENT_LENS_DB);
  await run("node", ["packages/ingest/dist/index.js", "--full", "--archive", CORPUS]);

  rmSync(OUT, { recursive: true, force: true });

  startServer();
  await waitForHealth(BASE);

  // Fixed (unfiltered) endpoints the SPA fetches. Keys are the client path passed to api(); values
  // are the snapshot file rel-path (= path with query stripped + ".json"). Keep in sync with api.ts.
  //
  // DELIBERATELY ABSENT: /api/about (ADR-027). It carries absolute filesystem paths from the machine
  // that ran this export, and everything written here is published to a public GitHub Pages demo.
  // Its absence is load-bearing, not an oversight — do not "fix" it by adding it. The SPA hides the
  // About page under SNAPSHOT so nothing links to the missing file; note that
  // check-snapshot-links.mjs would NOT catch a regression here, because it follows links rendered by
  // exported payloads and never parses SPA source.
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

  // File-modification provenance (ADR-022): the /files list + one timeline per file. The list
  // collapses to its default (unfiltered, last_ts desc) view like the other lists; limit=200 is the
  // server's max page (the demo corpus is well under it). Each row's timeline is keyed by a hash of
  // (path, project) — the file path has slashes so it can't be a route segment — which api.ts's
  // snapshotFileKey reproduces to fetch snapshot/file/<key>.json.
  //
  // BOTH link shapes must be exported, because `project` is optional on /api/file and the SPA emits
  // the query two different ways: FilesView links `?path=…&project=…`, while the session transcript's
  // "history →" link (transcript/FilesChanged.tsx) links `?path=…` alone. Those hash to DIFFERENT
  // keys, so exporting only the project-ful one 404s the demo's history link. They are separate
  // fetches rather than one payload under two names: without `project`, the timeline legitimately
  // aggregates every project that touched that path.
  const filesList = await getJson("/api/files?limit=200");
  writeSnap("files.json", filesList);
  const fileKeys = new Map(); // key → "project\0path", to catch a hash collision clobbering a row
  for (const f of filesList.files) {
    // variants: [project scoping used for the key, query params]. `null` = the path-only view.
    const variants = f.project_id ? [f.project_id, null] : [null];
    for (const project of variants) {
      const key = snapshotFileKey(f.file_path, project);
      const ident = `${project ?? ""}\0${f.file_path}`;
      const clash = fileKeys.get(key);
      if (clash && clash !== ident) throw new Error(`snapshotFileKey collision: ${clash} vs ${ident} → ${key}`);
      if (fileKeys.has(key)) continue; // same (project, path) reached twice — one fetch is enough
      fileKeys.set(key, ident);
      const fq = new URLSearchParams({ path: f.file_path });
      if (project) fq.set("project", project);
      writeSnap(`file/${key}.json`, await getJson("/api/file?" + fq.toString()));
    }
  }

  writeSnap("manifest.json", {
    generated_from: "test/fixtures/corpus",
    sources: (await getJson("/api/sources")).map((s) => s.label ?? s.id),
    sessions: ids.length,
    note: "Static corpus-only snapshot — filters/pagination collapse to the default view.",
  });

  console.log(
    `export-snapshot: wrote ${ids.length} sessions + ${runIds.size} workflows + ${filesList.files.length} files + dashboards to ${OUT}`,
  );
}

main()
  .then(() => { cleanup(); process.exit(0); })
  .catch((err) => {
    console.error("export-snapshot failed:", err.message);
    process.exit(1);
  });
