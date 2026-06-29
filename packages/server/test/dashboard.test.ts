/**
 * Dashboard aggregates (Phase 4) — the KPIs/breakdowns are computed at query time via GROUP BY, so
 * a wrong join or a folded-in cache-read silently corrupts every chart. These tests seed a small DB
 * with a HAND-COMPUTED scenario (two sources, a main+subagent split, a cache-heavy opus session, a
 * priced dated-haiku session, and an unpriced <synthetic> session) and assert exact numbers.
 * Foreign keys are left OFF — we test the aggregation SQL, not referential integrity.
 */
import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "@agent-lens/core";
import { dashboardOverview, dashboardBreakdowns, dashboardTimeseries } from "../dist/dashboard.js";

function seed(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.pragma("foreign_keys = OFF"); // test aggregation SQL, not the full FK graph
  // Sessions: m1 (isf, main, cache-heavy opus), a1 (isf, subagent, dated haiku), m2 (personal, main, <synthetic>).
  db.exec(`
    INSERT INTO sessions (id, agent_id, source_id, is_sidechain, started_at, turn_count) VALUES
      ('m1','claude-code','isf',0,'2026-01-01T00:00:00Z',2),
      ('a1','claude-code','isf',1,'2026-01-01T00:00:00Z',0),
      ('m2','claude-code','personal',0,'2026-01-02T00:00:00Z',1);
    INSERT INTO token_usage (event_uuid, session_id, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens) VALUES
      ('m1e','m1','claude-opus-4-8',1000000,1000000,1000000,10000000),
      ('a1e','a1','claude-haiku-4-5-20251001',100,100,0,0),
      ('m2e','m2','<synthetic>',500,500,0,0);
    INSERT INTO turns (id, session_id, seq, duration_ms) VALUES
      ('m1:0','m1',0,100),('m1:1','m1',1,300),('m2:0','m2',0,200);
    INSERT INTO tool_calls (id, session_id, tool_name, skill_name, agent_type, spawned_session_id) VALUES
      ('t1','m1','Bash',NULL,NULL,NULL),
      ('t2','m1','Bash',NULL,NULL,NULL),
      ('t3','m1','Skill','router',NULL,NULL),
      ('t4','m1','Agent',NULL,'Explore','a1');
    INSERT INTO classifications (scope, target_id, category, complexity_score, complexity_band, classifier_version) VALUES
      ('session','m1','feature',50,'medium',2),
      ('session','m2','bugfix',20,'small',2),
      ('session','a1','review',5,'trivial',2);
  `);
  return db;
}

describe("dashboardOverview", () => {
  let o: any;
  beforeAll(() => (o = dashboardOverview(seed(), {})));

  it("counts sessions split main vs subagent, and sums turn_count", () => {
    expect(o.sessions).toBe(3);
    expect(o.sessions_main).toBe(2);
    expect(o.sessions_subagent).toBe(1);
    expect(o.turns).toBe(3); // 2 + 0 + 1
    expect(o.tool_calls).toBe(4);
  });

  it("keeps the token split and never folds cache-read into one number", () => {
    expect(o.tokens).toEqual({ input: 1_000_600, output: 1_000_600, cache_creation: 1_000_000, cache_read: 10_000_000 });
    expect(o.total_tokens).toBe(13_001_200);
    expect(o.cache_read_ratio).toBeCloseTo(10_000_000 / 13_001_200, 10);
  });

  it("derives cache-aware cost and reports unpriced models honestly", () => {
    // opus: 5+25+6.25+5 = 41.25 ; haiku: (100+500)/1e6 = 0.0006 ; synthetic: 0 → 41.2506
    expect(o.cost).toBeCloseTo(41.2506, 6);
    expect(o.unpriced_models).toEqual(["<synthetic>"]);
  });

  it("computes turn-duration percentiles over non-null durations", () => {
    expect(o.turn_duration_ms).toEqual({ p50: 200, p95: 300, count: 3 });
  });
});

describe("dashboardBreakdowns", () => {
  let b: any;
  beforeAll(() => (b = dashboardBreakdowns(seed(), {})));

  it("orders models by total tokens and flags unpriced", () => {
    expect(b.by_model.map((m: any) => m.model)).toEqual(["claude-opus-4-8", "<synthetic>", "claude-haiku-4-5-20251001"]);
    const opus = b.by_model[0];
    expect(opus.total_tokens).toBe(13_000_000);
    expect(opus.cost).toBeCloseTo(41.25, 6);
    expect(opus.priced).toBe(true);
    expect(b.by_model.find((m: any) => m.model === "<synthetic>").priced).toBe(false);
  });

  it("counts sessions+turns per source (all sessions, incl. subagents)", () => {
    const isf = b.by_source.find((s: any) => s.source === "isf");
    const personal = b.by_source.find((s: any) => s.source === "personal");
    expect(isf.sessions).toBe(2); // m1 + a1
    expect(isf.turns).toBe(2); // turn_count 2 + 0
    expect(personal.sessions).toBe(1);
  });

  it("category/complexity breakdowns cover MAIN sessions only (subagents excluded)", () => {
    expect(b.by_category.find((c: any) => c.category === "feature").n).toBe(1);
    expect(b.by_category.find((c: any) => c.category === "bugfix").n).toBe(1);
    expect(b.by_category.find((c: any) => c.category === "review")).toBeUndefined(); // a1 is a subagent
  });

  it("ranks tools + skills and summarizes subagent fan-out", () => {
    expect(b.tools.find((t: any) => t.name === "Bash").n).toBe(2);
    expect(b.skills.find((s: any) => s.name === "router").n).toBe(1);
    expect(b.subagent_fanout.by_type.find((t: any) => t.type === "Explore").n).toBe(1);
    expect(b.subagent_fanout.sessions_with_subagents).toBe(1);
    expect(b.subagent_fanout.total_spawns).toBe(1);
    expect(b.subagent_fanout.avg_per_session).toBe(1);
  });
});

describe("dashboardTimeseries", () => {
  it("buckets by day over a short span and keeps per-bucket tokens/cost/sessions/turns", () => {
    const ts = dashboardTimeseries(seed(), {});
    expect(ts.bucket).toBe("day");
    expect(ts.series.map((s: any) => s.bucket)).toEqual(["2026-01-01", "2026-01-02"]);
    const d1 = ts.series[0];
    expect(d1.sessions).toBe(2); // m1 + a1 both started 2026-01-01
    expect(d1.turns).toBe(2); // m1's two turns
    expect(d1.cost).toBeCloseTo(41.2506, 4); // opus + haiku that day
    const d2 = ts.series[1];
    expect(d2.cost).toBe(0); // <synthetic> only
  });
});

describe("source filter scopes every aggregate", () => {
  it("restricts overview to one source", () => {
    const o = dashboardOverview(seed(), { source: "personal" });
    expect(o.sessions).toBe(1);
    expect(o.total_tokens).toBe(1000); // only m2's <synthetic>
    expect(o.cost).toBe(0);
  });
});
