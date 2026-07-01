#!/usr/bin/env node
/**
 * From-tarball smoke test (checkpoint 3 verification): pack the `agent-lens` CLI, extract it into a
 * directory OUTSIDE the repo, and run collect → ingest → serve against the committed corpus. Proves
 * the bundle needs no repo layout (findRepoRoot → null → per-user/overridden dirs), that the native
 * better-sqlite3 + fastify load, and that the web SPA is served from the bundled `web/`.
 *
 * The extracted package's node_modules is symlinked to the CLI package's already-resolved deps — the
 * same dependency trees a real `npm i -g agent-lens` provides — so the test is fast and offline.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const REPO = resolve(import.meta.dirname, "..");
const CLI = join(REPO, "packages/cli");
const CORPUS_LABEL = join(REPO, "test/fixtures/corpus/team-a"); // a source-shaped dir (has projects/)
const TMP = mkdtempSync(join(tmpdir(), "al-smoke."));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "pipe", encoding: "utf8", ...opts });
const ok = (m) => console.log("  PASS  " + m);
const fail = (m) => { console.error("  FAIL  " + m); process.exitCode = 1; };

let server;
process.on("exit", () => { if (server) try { server.kill(); } catch {} rmSync(TMP, { recursive: true, force: true }); });

// 1) Pack (runs the CLI `build` via prepack? no — pack uses current dist/; we built it already)
console.log("smoke: packing agent-lens…");
run("npm", ["pack", "--pack-destination", TMP], { cwd: CLI });
const tgz = readdirSync(TMP).find((f) => f.endsWith(".tgz"));
if (!tgz) { fail("npm pack produced no tarball"); process.exit(1); }

// 2) Assert tarball contents
const listing = run("tar", ["tzf", join(TMP, tgz)]);
for (const want of ["package/dist/agent-lens.js", "package/web/index.html", "package/package.json"]) {
  listing.includes(want) ? ok(`tarball contains ${want}`) : fail(`tarball MISSING ${want}`);
}

// 3) Extract OUTSIDE the repo and wire up node_modules (= the deps a real install would provide)
const pkg = join(TMP, "pkg");
mkdirSync(pkg);
run("tar", ["xzf", join(TMP, tgz), "-C", pkg, "--strip-components=1"]);
symlinkSync(join(CLI, "node_modules"), join(pkg, "node_modules"), "dir");
const entry = join(pkg, "dist", "agent-lens.js");

// 4) Run the pipeline against the corpus, entirely outside the repo
const DATA = join(TMP, "data");
const cfg = join(TMP, "sources.json");
writeFileSync(cfg, JSON.stringify({ sources: [{ label: "t", agent: "claude-code", configDir: CORPUS_LABEL }] }));
const env = { ...process.env, AGENT_LENS_DATA: DATA, AGENT_LENS_CONFIG: cfg, AGENT_LENS_PORT: "14733" };

console.log("smoke: agent-lens --version →", run("node", [entry, "--version"], { env }).trim());
const collectOut = run("node", [entry, "collect", "--then-ingest"], { env });
console.log(collectOut.trim().split("\n").map((l) => "    " + l).join("\n"));
/scanned=\d/.test(collectOut) ? ok("collect ran from extracted CLI (no repo present)") : fail("collect produced no output");
/sessions=\d/.test(collectOut) ? ok("ingest ran after collect (--then-ingest)") : fail("ingest did not run");

// 5) Serve + fetch health and the web index (proves fastify + bundled web/ resolution)
server = spawn("node", [entry, "serve"], { env, stdio: "ignore" });
const base = "http://127.0.0.1:14733";
let up = false;
for (let i = 0; i < 100; i++) {
  try { if ((await (await fetch(base + "/api/health")).json()).ok) { up = true; break; } } catch {}
  await new Promise((r) => setTimeout(r, 100));
}
up ? ok("server healthy") : fail("server did not become healthy");
if (up) {
  const html = await (await fetch(base + "/")).text();
  html.includes("<title>Agent Lens</title>") ? ok("web SPA served from bundled web/") : fail("web index not served");
  const s = await (await fetch(base + "/api/sessions")).json();
  const rows = s?.sessions ?? [];
  Array.isArray(rows) && rows.length > 0 ? ok(`API returns ${rows.length} ingested sessions`) : fail("API returned no sessions");
}
console.log(process.exitCode ? "\nsmoke: FAILED" : "\nsmoke: PASS (extracted CLI runs the full pipeline with no repo present)");
if (server) try { server.kill(); } catch {}
process.exit(process.exitCode ?? 0);
