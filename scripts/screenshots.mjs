#!/usr/bin/env node
/**
 * Capture demo screenshots from the committed corpus — no real data, fully reproducible.
 *
 * Launch recipe shared with export-snapshot.mjs (scripts/lib/sandbox.mjs): ingest the corpus into an
 * isolated temp DB and
 * start the read-only server (serving a LIVE web build), then drive headless Chromium to screenshot
 * the dashboard, the sessions list, and a session transcript (incl. the workflow fan-out + the
 * classifier "signals" explainer). PNGs land in docs/img/ and are embedded in README.md / docs/USAGE.md.
 *
 * Usage: node scripts/screenshots.mjs   (requires `pnpm build`; Playwright Chromium must be installed)
 *
 * Note: `playwright` is the one exact-pinned devDependency in the root package.json (no caret). This is
 * deliberate — the committed docs/img/ PNGs must be byte-reproducible across contributors, and a
 * Chromium bump can shift antialiasing/layout enough to churn the images. Bump the pin intentionally
 * and re-generate the screenshots in the same commit.
 */
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { createCorpusSandbox, waitForHealth, REPO, CORPUS } from "./lib/sandbox.mjs";

const IMG = join(REPO, "docs/img");
const PORT = Number(process.env.AGENT_LENS_PORT || 14499);

const { BASE, run, startServer, cleanup } = createCorpusSandbox({
  prefix: "al-shots.",
  dbName: "shots.db",
  port: PORT,
  env: { VITE_SNAPSHOT: "" }, // force a LIVE build (fetches the running API, not static snapshot files)
});

async function main() {
  if (!existsSync(join(REPO, "packages/ingest/dist/index.js"))) {
    throw new Error("dist not found — run `pnpm build` first");
  }
  console.log("screenshots: building web (live mode) + ingesting corpus");
  await run("node", ["packages/ingest/dist/index.js", "--full", "--archive", CORPUS]);
  await run("pnpm", ["--filter", "@agent-lens/web", "build"]); // live build (VITE_SNAPSHOT cleared)

  startServer();
  await waitForHealth(BASE);

  mkdirSync(IMG, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 });
  const go = async (path) => { await page.goto(BASE + path, { waitUntil: "networkidle" }); };
  const shot = async (name, opts = {}) => {
    // Scroll home before every capture. `.topbar` is `position: sticky`, and a fullPage screenshot
    // renders a sticky element wherever the CURRENT scroll offset puts it — so after expandTools()
    // has clicked its way down the page (each click scrolls the target into view), the nav bar was
    // being baked into the MIDDLE of the image instead of at its top. It is a capture artifact, not
    // a CSS bug: the live page is fine.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150); // let the sticky bar settle before the capture
    await page.screenshot({ path: join(IMG, name), ...opts });
    console.log("  wrote docs/img/" + name);
  };
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

  // 6) Security page — the browsable findings list, severity KPIs, framework anchors, and the
  //    "what & why" reference accordion (ADR-017).
  await go("/security");
  await page.waitForSelector("table.findings-table, .sev-kpis");
  await page.waitForTimeout(200);
  await shot("security.png", { fullPage: true });

  // 7) Security findings inline in a transcript — per-tool severity badges + the session banner.
  await go("/session/sc-security-0011");
  await page.waitForSelector(".security-banner");
  await expandTools();
  await shot("security-session.png", { fullPage: true });

  await browser.close();
  console.log("screenshots: done →", IMG);
}

main()
  .then(() => { cleanup(); process.exit(0); })
  .catch((err) => { console.error("screenshots failed:", err.message); process.exit(1); });
