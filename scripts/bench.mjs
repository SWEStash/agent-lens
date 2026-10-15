/**
 * Read-path benchmark: times every dashboard aggregate (and the heaviest non-dashboard reads)
 * against a real or synthetic DB, and compares the result to a saved baseline.
 *
 *   node scripts/bench.mjs --db data/agent-lens.db                 # your real store, read-only
 *   node scripts/bench.mjs --synthetic 18000 --out .local/perf/synth.db   # build + bench a synthetic corpus
 *   node scripts/bench.mjs --db … --cold                            # evict the DB from the page cache first
 *   node scripts/bench.mjs --db … --json bench.json                 # save a baseline
 *   node scripts/bench.mjs --db … --compare bench.json [--fail]     # diff against one (exit 1 with --fail)
 *
 * Calls the query functions directly (no HTTP), so a number here is pure SQLite + JS assembly time.
 * node:sqlite is synchronous: the server answers one request at a time, so the dashboard's real
 * wait is close to the SUM of its five endpoints, not the slowest one. That sum is reported as
 * `dashboard (serial)`.
 *
 * --cold uses posix_fadvise(DONTNEED) through python3 (Linux), dropping only this DB's clean pages
 * — no root needed. Run it from a disk-backed path: a DB on tmpfs is always resident and a "cold"
 * number there means nothing. A cold run measures each case once, so expect noise.
 *
 * Needs a build first (`pnpm build`) — it imports the packages' dist like the other scripts here.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { parseArgs } from "node:util";
import { ANALYZE_SQL } from "../packages/core/dist/schema.js";
import { openReadonly, listSessions, getSession, securitySummary, listFiles } from "../packages/server/dist/db.js";
import { dashboardOverview, dashboardTimeseries, dashboardBreakdowns, dashboardTime, dashboardAudit } from "../packages/server/dist/dashboard.js";
import { buildSynthCorpus } from "./lib/synth-corpus.mjs";

const { values: args } = parseArgs({
  options: {
    db: { type: "string" },
    synthetic: { type: "string" },
    out: { type: "string", default: ".local/perf/synth.db" },
    runs: { type: "string", default: "5" },
    cold: { type: "boolean", default: false },
    json: { type: "string" },
    compare: { type: "string" },
    fail: { type: "boolean", default: false },
    threshold: { type: "string", default: "0.25" },
    verbose: { type: "boolean", short: "v", default: false },
  },
});

let file = args.db;
if (args.synthetic) {
  file = args.out;
  for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
  const t = performance.now();
  const w = buildSynthCorpus({ file, sessions: Number(args.synthetic) });
  w.exec(ANALYZE_SQL); // what an ingest run leaves behind
  w.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  w.close();
  console.error(`built ${args.synthetic}-session synthetic corpus at ${file} in ${((performance.now() - t) / 1000).toFixed(1)}s`);
}
if (!file || !existsSync(file)) {
  console.error("usage: node scripts/bench.mjs (--db <file> | --synthetic <sessions>) [--cold] [--json out] [--compare base]");
  process.exit(2);
}

const db = openReadonly(file);
const counts = Object.fromEntries(
  ["sessions", "events", "tool_calls", "token_usage"].map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]),
);

// Statement-level timing: wrap prepare() so every .all()/.get() a case runs is attributed to its SQL.
const stmts = [];
const prepare = db.prepare.bind(db);
db.prepare = (sql) => {
  const st = prepare(sql);
  const timed = (fn) => (...a) => {
    const t = performance.now();
    try {
      return fn(...a);
    } finally {
      stmts.push([performance.now() - t, sql.replace(/\s+/g, " ").trim()]);
    }
  };
  return new Proxy(st, {
    get: (o, k) => (k === "all" || k === "get" ? timed(o[k].bind(o)) : typeof o[k] === "function" ? o[k].bind(o) : o[k]),
  });
};

const models = db.prepare("SELECT DISTINCT model FROM token_usage WHERE model IS NOT NULL ORDER BY model LIMIT 1").all().map((r) => r.model);
const span = db.prepare("SELECT MIN(started_at) mn, MAX(started_at) mx FROM sessions").get();
const lastMonth = span.mx ? new Date(Date.parse(span.mx) - 30 * 86_400_000).toISOString().slice(0, 10) : undefined;
const biggest = db.prepare("SELECT id FROM sessions ORDER BY event_count DESC LIMIT 1").get()?.id;

const FILTERS = { all: {}, model: { models }, "last-30d": { from: lastMonth } };
const DASH = {
  overview: (f) => dashboardOverview(db, f),
  timeseries: (f) => dashboardTimeseries(db, f),
  breakdowns: (f) => dashboardBreakdowns(db, f),
  time: (f) => dashboardTime(db, f),
  audit: (f) => dashboardAudit(db, f),
};
const cases = [];
for (const [fname, f] of Object.entries(FILTERS)) for (const [name, fn] of Object.entries(DASH)) cases.push([`dashboard/${name} [${fname}]`, () => fn(f)]);
cases.push(
  ["sessions [default]", () => listSessions(db, { limit: 50, offset: 0 })],
  ["sessions [sort=cost]", () => listSessions(db, { sort: "cost", dir: "desc", limit: 50, offset: 0 })],
  ["session detail [largest]", () => biggest && getSession(db, biggest)],
  ["security/summary", () => securitySummary(db)],
  ["files", () => listFiles(db, {})],
);

function evict() {
  const py = "import os,sys\nfor p in sys.argv[1:]:\n  fd=os.open(p,os.O_RDONLY); os.posix_fadvise(fd,0,0,os.POSIX_FADV_DONTNEED); os.close(fd)";
  execFileSync("python3", ["-I", "-c", py, ...[file, `${file}-wal`].filter(existsSync)]);
}

const runs = args.cold ? 1 : Number(args.runs);
const results = {};
for (const [name, fn] of cases) {
  if (args.cold) evict();
  else fn(); // warm-up: first touch pays the page faults and the statement compile
  const times = [];
  let top = [];
  for (let i = 0; i < runs; i++) {
    stmts.length = 0;
    const t = performance.now();
    fn();
    times.push(performance.now() - t);
    if (i === 0) top = [...stmts].sort((a, b) => b[0] - a[0]).slice(0, 3);
  }
  times.sort((a, b) => a - b);
  results[name] = { median_ms: round(times[Math.floor(times.length / 2)]), max_ms: round(times[times.length - 1]) };
  if (args.verbose) results[name].top = top.map(([ms, sql]) => `${round(ms)}ms ${sql.slice(0, 140)}`);
}
for (const fname of Object.keys(FILTERS)) {
  const sum = Object.keys(DASH).reduce((a, n) => a + results[`dashboard/${n} [${fname}]`].median_ms, 0);
  results[`dashboard (serial) [${fname}]`] = { median_ms: round(sum), max_ms: null };
}

const report = {
  when: new Date().toISOString(),
  db: file,
  mode: args.cold ? "cold" : "warm",
  runs,
  machine: { cpu: cpus()[0]?.model, cores: cpus().length, mem_gb: Math.round(totalmem() / 2 ** 30), node: process.version },
  counts,
  results,
};

const base = args.compare ? JSON.parse(readFileSync(args.compare, "utf8")) : null;
const threshold = Number(args.threshold);
let regressions = 0;
console.log(`${report.mode} · ${runs} run(s) · ${counts.sessions} sessions / ${counts.events} events · ${file}`);
for (const [name, r] of Object.entries(results)) {
  let delta = "";
  const b = base?.results?.[name];
  if (b) {
    const d = r.median_ms - b.median_ms;
    // Ratio AND absolute floor: +60% of a 3ms query is noise, not a regression.
    const bad = d > b.median_ms * threshold && d > 10;
    if (bad) regressions++;
    delta = `  ${b.median_ms.toFixed(1).padStart(9)} → ${d >= 0 ? "+" : ""}${((d / Math.max(b.median_ms, 0.1)) * 100).toFixed(0)}%${bad ? "  REGRESSION" : ""}`;
  }
  console.log(`${r.median_ms.toFixed(1).padStart(9)}ms  ${name}${delta}`);
  for (const line of r.top ?? []) console.log(`             ${line}`);
}
if (base && base.mode !== report.mode) console.log(`note: comparing a ${report.mode} run against a ${base.mode} baseline`);
if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 2) + "\n");
if (args.fail && regressions) process.exit(1);

function round(ms) {
  return Math.round(ms * 10) / 10;
}
