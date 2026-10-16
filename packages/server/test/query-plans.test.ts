/**
 * Query-plan guard for the dashboard aggregates. This is the CI half of the performance baseline;
 * scripts/bench.mjs is the timing half.
 *
 * Timings are too noisy for CI to gate on, but plan shape is deterministic, and on this data plan
 * shape is what decides speed. An `events` row averages ~3.4 KB and a `tool_calls` row ~2.3 KB, so
 * any plan step that reads those ROWS, rather than an index carrying the needed columns, costs one
 * random page read per row. On the real corpus that was the difference between 31s and 1.7s for
 * /dashboard/time from a cold cache. So every statement each aggregate runs, under every filter
 * shape, must touch those two tables only through a covering index.
 *
 * The corpus is synthetic and small, and its rows are narrow (`rowBytes`), because the planner costs
 * a plan from row COUNTS and declared columns, not stored widths. Stats are refreshed the way ingest
 * refreshes them. Without stats the planner prefers the primary-key index and reads the row.
 *
 * When this fails: the message names the statement and the offending step. Extend the matching
 * covering index in schema.ts (or narrow the query) instead of exempting it here.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { ANALYZE_SQL } from "@agent-lens/core";
import { buildSynthCorpus } from "../../../scripts/lib/synth-corpus.mjs";
import { dashboardOverview, dashboardTimeseries, dashboardBreakdowns, dashboardTime, dashboardAudit, type DashFilters } from "../dist/dashboard.js";

/** The wide tables. A plan step over either must say COVERING INDEX. */
const WIDE = ["events", "tool_calls"];

const AGGREGATES = {
  overview: dashboardOverview,
  timeseries: dashboardTimeseries,
  breakdowns: dashboardBreakdowns,
  time: dashboardTime,
  audit: dashboardAudit,
};
const FILTERS: Record<string, DashFilters> = {
  all: {},
  model: { models: ["claude-opus-4-8"] },
  "source+range": { source: "work", from: "2026-06-01", to: "2026-08-31" },
};

type Captured = { sql: string; params: unknown[] };

/** Run `fn` against `db`, recording every statement it executes with the parameters it bound. */
function capture(db: DatabaseSync, fn: () => unknown): Captured[] {
  const seen: Captured[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const st = prepare(sql);
    const rec = (method: "all" | "get") => (...params: unknown[]) => (seen.push({ sql, params }), (st[method] as Function)(...params));
    return new Proxy(st, { get: (o, k) => (k === "all" || k === "get" ? rec(k) : Reflect.get(o, k)) });
  }) as typeof db.prepare;
  try {
    fn();
  } finally {
    db.prepare = prepare;
  }
  return seen;
}

/** The names a wide table goes by in `sql`: itself, plus every alias it is given. */
function wideNames(sql: string): Set<string> {
  const names = new Set<string>();
  for (const t of WIDE) {
    if (!new RegExp(`\\b${t}\\b`).test(sql)) continue;
    names.add(t);
    for (const m of sql.matchAll(new RegExp(`\\b${t}\\s+(?:AS\\s+)?([a-z_][a-z0-9_]*)`, "gi"))) {
      const alias = m[1]!.toLowerCase();
      if (!["join", "where", "on", "group", "order", "left", "inner", "cross", "limit", "using", "as"].includes(alias)) names.add(alias);
    }
  }
  return names;
}

/** Plan steps that read a wide table's rows. */
function rowReads(db: DatabaseSync, c: Captured): string[] {
  const names = wideNames(c.sql);
  if (!names.size) return [];
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${c.sql}`).all(...(c.params as never[])) as Array<{ detail: string }>;
  return plan
    .map((p) => p.detail)
    .filter((d) => {
      const m = /^(?:SCAN|SEARCH) (\S+)/.exec(d);
      return m && names.has(m[1]!.toLowerCase()) && !d.includes("COVERING INDEX");
    });
}

describe("dashboard query plans read the wide tables only through covering indexes", () => {
  let db: DatabaseSync;
  beforeAll(() => {
    db = buildSynthCorpus({ sessions: 400, rowBytes: 16 });
    db.exec(ANALYZE_SQL);
  });

  for (const [fname, f] of Object.entries(FILTERS))
    for (const [name, fn] of Object.entries(AGGREGATES))
      it(`${name} [${fname}]`, () => {
        const stmts = capture(db, () => fn(db, f));
        expect(stmts.length).toBeGreaterThan(0);
        const offenders = stmts
          .map((c) => ({ sql: c.sql.replace(/\s+/g, " ").trim().slice(0, 200), steps: rowReads(db, c) }))
          .filter((o) => o.steps.length);
        expect(offenders).toEqual([]);
      });
});
