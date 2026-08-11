/**
 * Load every SPA route against a running agent-lens server and assert it renders:
 * HTTP 200, a page-specific selector present, and no console errors or failed requests.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const base = process.argv[2] || "http://127.0.0.1:4488";
const shotDir = process.argv[3] || "/tmp/agent-lens-sanity/shots";
mkdirSync(shotDir, { recursive: true });

const api = async (p) => (await fetch(base + p)).json();

// Real ids, so the detail routes exercise real rendering rather than an empty state.
const sessionId = (await api("/api/sessions?limit=1&kind=main")).sessions?.[0]?.id;
// /api/skills answers with a bare array; the other list endpoints answer { total, <name> }.
const skillName = (await api("/api/skills?limit=1"))[0]?.name;
const file = (await api("/api/files?limit=1")).files?.[0];

const routes = [
  ["sessions", "/", "table, [data-testid=sessions]"],
  ["dashboard", "/dashboard", "svg, canvas"],
  ["files", "/files", "table"],
  ["skills", "/skills", "table, ul"],
  ["security", "/security", "table"],
  ["about", "/about", "dl, table, section"],
  // `.transcript` is the container the turns render into (SessionView.tsx) — a generic tag would
  // match the page chrome and pass before the transcript has actually loaded.
  sessionId && ["session", `/session/${sessionId}`, ".transcript"],
  // The version picker: present only once the skill's detail actually loaded.
  skillName && ["skill", `/skill/${encodeURIComponent(skillName)}`, "select"],
  file && [
    "file",
    `/file?path=${encodeURIComponent(file.file_path)}&project=${encodeURIComponent(file.project_id)}`,
    "section, table, ol",
  ],
].filter(Boolean);

const browser = await chromium.launch();
let failures = 0;

for (const [name, path, selector] of routes) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const netErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  page.on("requestfailed", (r) => netErrors.push(`${r.url()} ${r.failure()?.errorText}`));
  page.on("response", (r) => {
    if (r.status() >= 400) netErrors.push(`${r.status()} ${r.url()}`);
  });

  let status = "?";
  let selectorOk = false;
  try {
    const resp = await page.goto(base + path, { waitUntil: "networkidle", timeout: 30000 });
    status = resp?.status();
    await page.waitForSelector(selector, { timeout: 10000 });
    selectorOk = true;
  } catch (e) {
    consoleErrors.push("navigation/selector: " + e.message.split("\n")[0]);
  }
  await page.screenshot({ path: `${shotDir}/${name}.png`, fullPage: false });

  const ok = status === 200 && selectorOk && consoleErrors.length === 0 && netErrors.length === 0;
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name.padEnd(10)} ${String(status).padEnd(4)} selector=${selectorOk}  ${path}`,
  );
  for (const e of consoleErrors) console.log(`        console: ${e}`);
  for (const e of netErrors) console.log(`        network: ${e}`);
  await ctx.close();
}

await browser.close();
console.log(`\n${routes.length - failures}/${routes.length} routes passed`);
process.exit(failures ? 1 : 0);
