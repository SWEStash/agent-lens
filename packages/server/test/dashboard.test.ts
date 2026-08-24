/**
 * Dashboard aggregates — the KPIs/breakdowns are computed at query time via GROUP BY, so
 * a wrong join or a folded-in cache-read silently corrupts every chart. These tests seed a small DB
 * with a HAND-COMPUTED scenario (two sources, a main+subagent split, a cache-heavy opus session, a
 * priced dated-haiku session, and an unpriced <synthetic> session) and assert exact numbers.
 * Foreign keys are left OFF — we test the aggregation SQL, not referential integrity.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "@agent-lens/core";
import { dashboardOverview, dashboardBreakdowns, dashboardTimeseries, dashboardTime } from "../dist/dashboard.js";

function seed(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec("PRAGMA foreign_keys = OFF"); // test aggregation SQL, not the full FK graph
  // Sessions: m1 (isf, main, cache-heavy opus), a1 (isf, subagent, dated haiku), m2 (personal, main, <synthetic>).
  db.exec(`
    INSERT INTO sessions (id, agent_id, source_id, is_sidechain, started_at, duration_ms, turn_count) VALUES
      ('m1','claude-code','isf',0,'2026-01-01T00:00:00Z',1000,2),
      ('a1','claude-code','isf',1,'2026-01-01T00:00:00Z',500,0),
      ('m2','claude-code','personal',0,'2026-01-02T00:00:00Z',3000,1);
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
    INSERT INTO workflow_results (run_id, source_id, status, total_tokens, duration_ms, started_at) VALUES
      ('wf1','isf','completed',1000,2000,'2026-01-01T00:00:00Z'),
      ('wf2','isf','completed',3000,4000,'2026-01-01T00:00:00Z'),
      ('wf3','isf','failed',500,1000,'2026-01-02T00:00:00Z'),
      ('wf4','personal','running',NULL,NULL,'2026-01-02T00:00:00Z');
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

  it("computes session-duration percentiles over MAIN sessions only (subagent a1 excluded)", () => {
    expect(o.session_duration_ms).toEqual({ p50: 1000, p95: 3000, count: 2 }); // m1=1000, m2=3000; a1 skipped
  });

  it("rolls up workflow runs: outcomes, success over decided runs, token/duration sums", () => {
    expect(o.workflows.total).toBe(4);
    expect(o.workflows.completed).toBe(2);
    expect(o.workflows.failed).toBe(1);
    expect(o.workflows.success_rate).toBeCloseTo(2 / 3, 10); // running excluded from the denominator
    expect(o.workflows.total_tokens).toBe(4500); // 1000 + 3000 + 500 + 0
    expect(o.workflows.avg_duration_ms).toBe(2333); // round((2000+4000+1000)/3)
    expect(o.workflows.by_status.find((s: any) => s.status === "completed").n).toBe(2);
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
    expect(o.workflows.total).toBe(1); // only the personal 'running' run; success_rate 0 (none decided)
    expect(o.workflows.success_rate).toBe(0);
  });
});

/**
 * A second, purpose-built corpus for the time analytics. It exists separately because those queries
 * need what the aggregate seed above deliberately omits: real event timestamps, turn spans, and a
 * session whose events run for hours after it started.
 *
 * `long` is the whole point — it starts at 22:00 and spends tokens at 22:00, 23:00 and 01:00 the
 * next day. Every other dashboard series would attribute all of it to the 22:00 hour.
 */
function seedTime(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    INSERT INTO sessions (id, agent_id, source_id, is_sidechain, started_at) VALUES
      ('long','claude-code','isf',0,'2026-03-01T22:00:00Z'),
      ('sub','claude-code','isf',1,'2026-03-01T22:00:00Z');
    INSERT INTO events (uuid, session_id, turn_id, type, role, timestamp, raw_json) VALUES
      ('e1','long','long:0','assistant','assistant','2026-03-01T22:00:30Z',x''),
      ('e2','long','long:0','assistant','assistant','2026-03-01T23:10:00Z',x''),
      ('e3','long','long:1','assistant','assistant','2026-03-02T01:30:00Z',x''),
      ('s1','sub','sub:0','assistant','assistant','2026-03-01T22:05:00Z',x'');
    INSERT INTO token_usage (event_uuid, session_id, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens) VALUES
      ('e1','long','claude-opus-5',10,20,30,9999),
      ('e2','long','claude-opus-5',1,1,1,9999),
      ('e3','long','claude-opus-5',100,100,100,9999),
      ('s1','sub','claude-opus-5',5,5,5,9999);
    INSERT INTO turns (id, session_id, seq, model, started_at, ended_at) VALUES
      ('long:0','long',0,'claude-opus-5','2026-03-01T22:00:00Z','2026-03-01T23:10:00Z'),
      ('long:1','long',1,'claude-opus-5','2026-03-01T23:10:05Z','2026-03-02T01:30:00Z'),
      ('sub:0','sub',0,'claude-opus-5','2026-03-01T22:04:00Z','2026-03-01T22:05:00Z');
    INSERT INTO tool_calls (id, session_id, turn_id, tool_name) VALUES ('tc1','long','long:0','Edit');
    INSERT INTO file_changes (id, tool_call_id, session_id, turn_id, file_path, tool_name) VALUES
      ('fc1','tc1','long','long:0','a.ts','Edit');
  `);
  return db;
}

/** Five main-session turns in one week, with hand-picked latencies (1s, 2s, 3s, 4s, 100s) so the
 *  nearest-rank percentiles are checkable by eye. Just clears MIN_LATENCY_SAMPLES. */
function seedLatency(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec("PRAGMA foreign_keys = OFF");
  const secs = [1, 2, 3, 4, 100];
  const rows = secs
    .map((sec, i) => {
      const start = `2026-03-0${i + 2}T10:00:00Z`;
      const reply = new Date(Date.parse(start) + sec * 1000).toISOString().replace(".000Z", "Z");
      return {
        turn: `('t${i}','lat',${i},'claude-opus-5','${start}','${reply}')`,
        event: `('e${i}','lat','t${i}','assistant','assistant','${reply}',x'')`,
      };
    });
  db.exec(`
    INSERT INTO sessions (id, agent_id, source_id, is_sidechain, started_at) VALUES
      ('lat','claude-code','isf',0,'2026-03-02T10:00:00Z');
    INSERT INTO turns (id, session_id, seq, model, started_at, ended_at) VALUES ${rows.map((r) => r.turn).join(",")};
    INSERT INTO events (uuid, session_id, turn_id, type, role, timestamp, raw_json) VALUES ${rows.map((r) => r.event).join(",")};
  `);
  return db;
}

describe("dashboardTime", () => {
  it("buckets burn by the usage event's own hour, not the session's start hour", () => {
    const t = dashboardTime(seedTime(), {});
    const isf = t.burn_hours.filter((r: any) => r.source === "isf");
    expect(isf.map((r: any) => r.hour)).toEqual(["2026-03-01T22", "2026-03-01T23", "2026-03-02T01"]);
    // 22:00 holds e1 (60) plus the subagent's s1 (15) — spend counts both populations.
    expect(isf.map((r: any) => r.work)).toEqual([75, 3, 300]);
  });

  it("excludes cache-read from work tokens", () => {
    const t = dashboardTime(seedTime(), {});
    expect(t.burn_hours.reduce((a: number, r: any) => a + r.work, 0)).toBe(378); // not 40k-odd
  });

  it("drops a bucket holding too few turns to have a percentile", () => {
    // `long` has two turns. A p90 over two observations is just the larger one, so the row is not
    // reported at all rather than plotted as if it meant something.
    expect(dashboardTime(seedTime(), {}).latency.series).toEqual([]);
  });

  it("measures prompt to first assistant token per model, main sessions only", () => {
    const t = dashboardTime(seedLatency(), {});
    expect(t.latency.series).toHaveLength(1); // one bucket, one model — the subagent is excluded
    const row = t.latency.series[0];
    expect(row.model).toBe("claude-opus-5");
    expect(row.n).toBe(5);
    // Latencies are 1s, 2s, 3s, 4s, 100s. Nearest-rank over n=5: p50 is the 3rd, p90 the 5th.
    expect(row.p50_ms).toBe(3_000);
    expect(row.p90_ms).toBe(100_000);
  });

  it("excludes <synthetic> turns, which are replies generated without calling a model", () => {
    const db = seedLatency();
    // Same shape as the fixture's turns, but marked synthetic and far slower — exactly the row that
    // used to own the whole y-axis. Five of them, so it would clear MIN_LATENCY_SAMPLES if counted.
    const rows = [0, 1, 2, 3, 4]
      .map((i) => {
        const start = `2026-03-0${i + 2}T12:00:00Z`;
        const reply = new Date(Date.parse(start) + 3_600_000).toISOString().replace(".000Z", "Z");
        return {
          turn: `('s${i}','lat',${i + 10},'<synthetic>','${start}','${reply}')`,
          event: `('se${i}','lat','s${i}','assistant','assistant','${reply}',x'')`,
        };
      });
    db.exec(`
      INSERT INTO turns (id, session_id, seq, model, started_at, ended_at) VALUES ${rows.map((r) => r.turn).join(",")};
      INSERT INTO events (uuid, session_id, turn_id, type, role, timestamp, raw_json) VALUES ${rows.map((r) => r.event).join(",")};
    `);
    const models = dashboardTime(db, {}).latency.series.map((r) => r.model);
    expect(models).not.toContain("<synthetic>");
    expect(models).toEqual(["claude-opus-5"]);
  });

  it("keeps turns whose model is unknown rather than dropping them with the synthetic ones", () => {
    // `IS NOT '<synthetic>'` and `<> '<synthetic>'` differ exactly here: NULL <> 'x' is NULL, so the
    // plain comparison would silently discard every unattributed turn.
    const db = seedLatency();
    db.exec("UPDATE turns SET model = NULL");
    expect(dashboardTime(db, {}).latency.series.map((r) => r.model)).toEqual(["(unknown)"]);
  });

  it("follows the requested bucket rather than forcing a weekly floor", () => {
    // A daily bucket used to be silently rewritten to weekly. What keeps a fine bucket honest is
    // MIN_LATENCY_SAMPLES dropping the cells that cannot carry a percentile (asserted above), not
    // refusing the granularity outright.
    for (const bucket of ["day", "week", "month"] as const) {
      const t = dashboardTime(seedLatency(), {}, bucket);
      expect(t.latency.bucket).toBe(bucket);
      // The fixture's turns all hang off one session start, so they share a cell at every
      // granularity and clear the floor in each.
      expect(t.latency.series).toHaveLength(1);
      expect(t.latency.series[0].n).toBe(5);
    }
  });

  it("splits turnaround by whether the turn wrote files", () => {
    const t = dashboardTime(seedTime(), {});
    // long:0 wrote a.ts and long:1 started 5s later; long:1 has no successor.
    expect(t.review.wrote).toEqual({ n: 1, under_10s: 1, under_30s: 1, under_2min: 1 });
    expect(t.review.none.n).toBe(0);
  });

  it("returns the same shape with no rows at all", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA_SQL);
    const t = dashboardTime(db, {});
    expect(t.burn_hours).toEqual([]);
    expect(t.latency.series).toEqual([]);
    expect(t.review.wrote).toEqual({ n: 0, under_10s: 0, under_30s: 0, under_2min: 0 });
  });

  it("scopes to the source filter", () => {
    expect(dashboardTime(seedTime(), { source: "personal" }).burn_hours).toEqual([]);
  });
});
