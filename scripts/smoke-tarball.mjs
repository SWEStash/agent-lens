#!/usr/bin/env node
/**
 * From-tarball smoke test (checkpoint 3/5 verification): pack the `agent-lens` CLI, install it
 * OUTSIDE the repo, and run collect → ingest → serve against the committed corpus. Proves the bundle
 * needs no repo layout (findRepoRoot → null → per-user/overridden dirs), that native better-sqlite3 +
 * fastify load, and that the web SPA is served from the bundled `web/`.
 *
 * Two modes:
 *   (default)   fast + offline — extract the tarball and symlink the CLI package's already-resolved
 *               node_modules (the same dependency trees a real install provides). For local dev loops.
 *   --global    real `npm install -g --prefix <tmp>` of the packed tarball, so npm resolves deps from
 *               the registry and better-sqlite3's prebuild-install fetches the platform's Node-ABI
 *               prebuilt binary — the exact path a `npm i -g agent-lens` user hits. This is the
 *               release gate; it needs network access.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const GLOBAL = process.argv.includes("--global");
const REPO = resolve(import.meta.dirname, "..");
const CLI = join(REPO, "packages/cli");
const CORPUS_LABEL = join(REPO, "test/fixtures/corpus/team-a"); // a source-shaped dir (has projects/)
const TMP = mkdtempSync(join(tmpdir(), "al-smoke."));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "pipe", encoding: "utf8", ...opts });
const ok = (m) => console.log("  PASS  " + m);
const fail = (m) => { console.error("  FAIL  " + m); process.exitCode = 1; };

let server;
process.on("exit", () => { if (server) try { server.kill(); } catch {} rmSync(TMP, { recursive: true, force: true }); });

// 1) Pack (uses the current dist/ — we built it already; prepack would rebuild on a real publish)
console.log(`smoke${GLOBAL ? " (global)" : ""}: packing agent-lens…`);
run("npm", ["pack", "--pack-destination", TMP], { cwd: CLI });
const tgz = readdirSync(TMP).find((f) => f.endsWith(".tgz"));
if (!tgz) { fail("npm pack produced no tarball"); process.exit(1); }

// 2) Assert tarball contents
const listing = run("tar", ["tzf", join(TMP, tgz)]);
for (const want of ["package/dist/agent-lens.js", "package/web/index.html", "package/package.json", "package/README.md", "package/LICENSE"]) {
  listing.includes(want) ? ok(`tarball contains ${want}`) : fail(`tarball MISSING ${want}`);
}
listing.includes("package/web/snapshot/") ? fail("tarball ships web/snapshot/ demo cruft") : ok("tarball excludes web/snapshot/ demo cruft");

// 3) Install OUTSIDE the repo, either by symlinking resolved deps (fast) or a real global install.
//    `runCli(args, opts)` abstracts over "node <bundle>" vs the installed `agent-lens` bin.
let runCli;
if (GLOBAL) {
  const prefix = join(TMP, "gprefix");
  mkdirSync(prefix);
  console.log("smoke (global): npm install -g the tarball (fetches better-sqlite3 prebuild)…");
  run("npm", ["install", "-g", "--prefix", prefix, join(TMP, tgz)], { stdio: "inherit" });
  const bin = join(prefix, "bin", "agent-lens");
  ok(`installed bin at ${bin}`);
  runCli = (args, opts = {}) => run(bin, args, opts);
} else {
  const pkg = join(TMP, "pkg");
  mkdirSync(pkg);
  run("tar", ["xzf", join(TMP, tgz), "-C", pkg, "--strip-components=1"]);
  symlinkSync(join(CLI, "node_modules"), join(pkg, "node_modules"), "dir");
  const entry = join(pkg, "dist", "agent-lens.js");
  runCli = (args, opts = {}) => run("node", [entry, ...args], opts);
}

// 4) Run the pipeline against the corpus, entirely outside the repo
const DATA = join(TMP, "data");
const cfg = join(TMP, "sources.json");
writeFileSync(cfg, JSON.stringify({ sources: [{ label: "t", agent: "claude-code", configDir: CORPUS_LABEL }] }));
const env = { ...process.env, AGENT_LENS_DATA: DATA, AGENT_LENS_CONFIG: cfg, AGENT_LENS_PORT: "14733" };

console.log("smoke: agent-lens --version →", runCli(["--version"], { env }).trim());
const collectOut = runCli(["collect", "--then-ingest"], { env });
console.log(collectOut.trim().split("\n").map((l) => "    " + l).join("\n"));
/scanned=\d/.test(collectOut) ? ok("collect ran from installed CLI (no repo present)") : fail("collect produced no output");
/sessions=\d/.test(collectOut) ? ok("ingest ran after collect (--then-ingest)") : fail("ingest did not run");

// 5) Serve + fetch health and the web index (proves fastify + bundled web/ resolution)
if (GLOBAL) {
  const bin = join(TMP, "gprefix", "bin", "agent-lens");
  server = spawn(bin, ["serve"], { env, stdio: "ignore" });
} else {
  server = spawn("node", [join(TMP, "pkg", "dist", "agent-lens.js"), "serve"], { env, stdio: "ignore" });
}
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
console.log(process.exitCode ? "\nsmoke: FAILED" : `\nsmoke: PASS (${GLOBAL ? "globally-installed" : "extracted"} CLI runs the full pipeline with no repo present)`);
if (server) try { server.kill(); } catch {}
process.exit(process.exitCode ?? 0);
