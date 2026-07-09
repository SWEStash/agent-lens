#!/usr/bin/env node
/**
 * Capture demo screenshots from the committed corpus — no real data, fully reproducible.
 *
 * Same launch recipe as scripts/sandbox.sh: ingest the 3-source corpus into an isolated temp DB and
 * start the read-only server (serving a LIVE web build), then drive headless Chromium to screenshot
 * the dashboard, the sessions list, and a session transcript (incl. the workflow fan-out + the
 * classifier "signals" explainer). PNGs land in docs/img/ and are embedded in README.md / docs/USAGE.md.
 *
 * Usage: node scripts/screenshots.mjs   (requires `pnpm build`; Playwright Chromium must be installed)
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = join(REPO, "test/fixtures/corpus");
const IMG = join(REPO, "docs/img");
const PORT = Number(process.env.AGENT_LENS_PORT || 14499);
const BASE = `http://127.0.0.1:${PORT}`;

const SBX = mkdtempSync(join(tmpdir(), "al-shots."));
const env = {
  ...process.env,
  AGENT_LENS_DATA: SBX,
  AGENT_LENS_ARCHIVE: CORPUS,
  AGENT_LENS_DB: join(SBX, "shots.db"),
  AGENT_LENS_CONFIG: join(SBX, "sources.json"),
  AGENT_LENS_PORT: String(PORT),
  VITE_SNAPSHOT: "", // force a LIVE build (fetches the running API, not static snapshot files)
};
writeFileSync(
  env.AGENT_LENS_CONFIG,
  JSON.stringify({
    sources: [
      // Demo screenshots use ONLY the synthetic, readable `scenarios` source (no redacted-real data).
      { label: "scenarios", agent: "claude-code", configDir: "/unused-in-ingest" },
    ],
  }),
);

const run = (cmd, args) =>
  new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: "inherit", env, cwd: REPO });
    p.on("exit", (c) => (c === 0 ? res() : rej(new Error(`${cmd} ${args.join(" ")} → ${c}`))));
    p.on("error", rej);
  });

let server;
function cleanup() {
  if (server) try { server.kill(); } catch { /* ignore */ }
  rmSync(SBX, { recursive: true, force: true });
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

async function waitForHealth() {
  for (let i = 0; i < 100; i++) {
    try { if ((await (await fetch(BASE + "/api/health")).json()).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become healthy");
}

async function main() {
  if (!existsSync(join(REPO, "packages/ingest/dist/index.js"))) {
    throw new Error("dist not found — run `pnpm build` first");
  }
  console.log("screenshots: building web (live mode) + ingesting corpus");
  await run("node", ["packages/ingest/dist/index.js", "--full"]);
  await run("pnpm", ["--filter", "@agent-lens/web", "build"]); // live build (VITE_SNAPSHOT cleared)

  server = spawn("node", ["packages/server/dist/index.js"], { stdio: "ignore", env, cwd: REPO });
  await waitForHealth();

  mkdirSync(IMG, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 });
  const go = async (path) => { await page.goto(BASE + path, { waitUntil: "networkidle" }); };
  const shot = async (name, opts = {}) => { await page.screenshot({ path: join(IMG, name), ...opts }); console.log("  wrote docs/img/" + name); };
  // Tool cards (Bash console, Edit/Write diff, generic chips) render collapsed by default; expand them
  // all so the screenshots show the rendered content, not just the headers.
  const expandTools = async () => {
    for (let i = 0; i < 60; i++) {
      const h = page.locator("button.tool-head[aria-expanded='false']").first();
      if ((await h.count()) === 0) break;
      await h.click().catch(() => {});
    }
    // Un-clamp any collapsed prose (e.g. the approved-plan card's CollapsibleText).
    for (const b of await page.getByRole("button", { name: /show more/i }).all()) await b.click().catch(() => {});
    await page.waitForTimeout(200);
  };

  // 1) Dashboard — KPIs (token breakdown, cost, cache-read ratio), charts, and breakdowns
  //    (by-model, by-source, subagent fan-out). Full page captures all of it.
  await go("/dashboard");
  await page.waitForSelector(".kpis");
  await page.waitForSelector(".cards svg", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800); // let recharts finish animating
  await shot("dashboard.png", { fullPage: true });

  // 2) Sessions list — the browseable, filterable index.
  await go("/");
  await page.waitForSelector("table, .empty");
  await shot("sessions.png");

  // 3) Session transcript — the Bash shell-console renderer: a $ prompt per logical command
  //    (heredoc-/quote-aware), the description as a # caption, flag badges, and multi-line output.
  await go("/session/sc-bash-0008");
  await page.waitForSelector(".events, .transcript, main");
  await expandTools();
  await shot("session-transcript.png", { fullPage: true });

  // 4) Edit/MultiEdit/Write — the colored +/- diff renderer (context kept, per-edit hunks).
  await go("/session/sc-edit-0009");
  await page.waitForSelector("main");
  await expandTools();
  await shot("session-diff.png", { fullPage: true });

  // 5) Workflow detail — the fan-out run: phase graph (from the result sidecar), per-agent rows,
  //    roll-up tokens/tool-calls, and links back to the launching turn.
  await go("/workflow/wf_demo000abc");
  await page.waitForSelector("main");
  await page.waitForTimeout(400);
  await shot("workflow.png", { fullPage: true });

  await browser.close();
  console.log("screenshots: done →", IMG);
}

main()
  .then(() => { cleanup(); process.exit(0); })
  .catch((err) => { console.error("screenshots failed:", err.message); process.exit(1); });
