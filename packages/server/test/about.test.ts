/**
 * GET /api/about — the read-only diagnostics surface (ADR-027).
 *
 * Two properties carry the design and are what these pin:
 *   1. It reports what the server was STARTED with, not a fresh resolution — otherwise `serve --db`
 *      would show a path nobody is reading.
 *   2. It is absent unless that context was supplied, so an embedder with nothing truthful to say
 *      says nothing rather than guessing.
 *
 * Storage comes from `ingest_state`, which is also the ingest bookkeeping — so the numbers are
 * "as of the last ingest" by construction, and must survive that table being empty or absent.
 * Imports the BUILT dist (matches the other server suites).
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { PRICE_TABLE, resolvePricing, SCHEMA_SQL, usePricing } from "@agent-lens/core";
import { addEvent, addTokens, appFor, freshDb, seedBasic } from "./helpers/seed";

const CTX = {
  db: { path: "/tmp/nowhere/custom.db", origin: "flag" as const },
  host: "127.0.0.1",
  port: 4477,
  loopbackOnly: true,
  repoRoot: null,
  // The price table the process installed at startup (ADR-028), same as the other facts here: passed
  // in rather than re-resolved, so a test can pin overrides without touching a config file.
  pricing: resolvePricing(null),
};

const getAbout = async (db: Database.Database, ctx = CTX) => {
  const app = await appFor(db, { about: ctx });
  const res = await app.inject({ method: "GET", url: "/api/about" });
  await app.close();
  return res;
};

describe("about: registration", () => {
  it("is not registered when no context was supplied", async () => {
    const app = await appFor(seedBasic());
    expect((await app.inject({ method: "GET", url: "/api/about" })).statusCode).toBe(404);
    await app.close();
  });

  it("is served when the context is supplied", async () => {
    expect((await getAbout(seedBasic())).statusCode).toBe(200);
  });
});

describe("about: reports the startup facts, not a re-resolution", () => {
  it("echoes the db path and origin it was started with", async () => {
    const body = (await getAbout(seedBasic())).json();
    // The point of the whole context-passing design: a --db override must show up here.
    expect(body.paths.db).toEqual({ path: "/tmp/nowhere/custom.db", origin: "flag" });
  });

  it("derives triage_db beside the db, marked fixed (ADR-021)", async () => {
    const body = (await getAbout(seedBasic())).json();
    expect(body.paths.triage_db.origin).toBe("fixed");
    expect(body.paths.triage_db.path).toContain("/tmp/nowhere/"); // beside the db we were given
  });

  it("echoes the server binding", async () => {
    const body = (await getAbout(seedBasic())).json();
    expect(body.server).toEqual({ host: "127.0.0.1", port: 4477, loopback_only: true });
  });

  it("reports a non-loopback bind honestly", async () => {
    const body = (await getAbout(seedBasic(), { ...CTX, host: "0.0.0.0", loopbackOnly: false })).json();
    expect(body.server).toMatchObject({ host: "0.0.0.0", loopback_only: false });
  });
});

describe("about: versions", () => {
  it("carries the resolved app version and its source", async () => {
    const body = (await getAbout(seedBasic())).json();
    expect(body.versions.app.length).toBeGreaterThan(0);
    expect(["npm", "git", "unknown"]).toContain(body.versions.app_source);
  });

  // SCHEMA_SQL creates the `meta` table but does not populate it — ingest stamps schema_version. So
  // these set it explicitly rather than assuming a seeded DB carries one.
  const stampSchema = (db: Database.Database, v: number) =>
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(v));

  it("reports a current schema as not stale", async () => {
    const db = seedBasic();
    const expected = (await getAbout(db)).json().versions.schema_expected;
    stampSchema(db, expected);
    const body = (await getAbout(db)).json();
    expect(body.versions.schema).toBe(expected);
    expect(body.versions.schema_stale).toBe(false);
  });

  it("flags a schema older than this build expects", async () => {
    const db = seedBasic();
    stampSchema(db, 1);
    const body = (await getAbout(db)).json();
    expect(body.versions.schema).toBe(1);
    expect(body.versions.schema_stale).toBe(true);
  });

  it("reports what a re-run would produce AND what produced the stored rows", async () => {
    const db = seedBasic();
    // Two findings stamped by an older detector than this build writes.
    db.prepare("INSERT INTO tool_calls (id, session_id, tool_name) VALUES ('tcx','sess1','Bash')").run();
    const ins = db.prepare(
      "INSERT INTO findings (id, session_id, tool_call_id, event_uuid, rule_id, category, framework_ref, severity, title, evidence, signals_json, detector_version) VALUES (?,'sess1','tcx','e1','r','c','f','low','t','e','{}',?)",
    );
    ins.run("f1", 7);
    ins.run("f2", 7);

    const d = (await getAbout(db)).json().versions.detector;
    expect(d.in_data).toEqual([7]);
    expect(d.expected).toBeGreaterThan(7);
    expect(d.stale).toBe(true); // a re-run would relabel them
  });

  it("is not stale when the stored rows already match this build", async () => {
    const db = seedBasic();
    const expected = (await getAbout(db)).json().versions.detector.expected;
    db.prepare("INSERT INTO tool_calls (id, session_id, tool_name) VALUES ('tcy','sess1','Bash')").run();
    db.prepare(
      "INSERT INTO findings (id, session_id, tool_call_id, event_uuid, rule_id, category, framework_ref, severity, title, evidence, signals_json, detector_version) VALUES ('f3','sess1','tcy','e1','r','c','f','low','t','e','{}',?)",
    ).run(expected);

    const d = (await getAbout(db)).json().versions.detector;
    expect(d.in_data).toEqual([expected]);
    expect(d.stale).toBe(false);
  });

  it("does not flag rows stamped NEWER than this build as stale", async () => {
    // An older server reading a DB a newer ingest wrote. Re-running would DOWNGRADE those rows, so
    // calling it "stale" would prompt exactly the wrong action.
    const db = seedBasic();
    const expected = (await getAbout(db)).json().versions.detector.expected;
    db.prepare("INSERT INTO tool_calls (id, session_id, tool_name) VALUES ('tcz','sess1','Bash')").run();
    db.prepare(
      "INSERT INTO findings (id, session_id, tool_call_id, event_uuid, rule_id, category, framework_ref, severity, title, evidence, signals_json, detector_version) VALUES ('f4','sess1','tcz','e1','r','c','f','low','t','e','{}',?)",
    ).run(expected + 1);

    expect((await getAbout(db)).json().versions.detector.stale).toBe(false);
  });

  it("reports empty in_data when nothing has been stored yet", async () => {
    const v = (await getAbout(freshDb())).json().versions;
    expect(v.detector.in_data).toEqual([]);
    expect(v.detector.stale).toBe(false);
    expect(v.classifier.in_data).toEqual([]);
  });

  it("reports an unstamped DB as null, and not as stale", async () => {
    // A DB that predates the stamp isn't known-old, it's unknown — claiming "stale" would send the
    // user to run a full re-ingest on no evidence.
    const body = (await getAbout(seedBasic())).json();
    expect(body.versions.schema).toBeNull();
    expect(body.versions.schema_stale).toBe(false);
  });
});

describe("about: retention", () => {
  const KEY = "AGENT_LENS_VERSIONS_KEEP_DAYS";

  it("reports the built-in default when the env is unset", async () => {
    const saved = process.env[KEY];
    delete process.env[KEY];
    try {
      expect((await getAbout(seedBasic())).json().retention).toEqual({ versions_keep_days: 90, origin: "default" });
    } finally {
      if (saved !== undefined) process.env[KEY] = saved;
    }
  });

  it("reports an env override as env-sourced", async () => {
    const saved = process.env[KEY];
    process.env[KEY] = "30";
    try {
      expect((await getAbout(seedBasic())).json().retention).toEqual({ versions_keep_days: 30, origin: "env" });
    } finally {
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
    }
  });

  it("falls back to the default when the env value is not a number", async () => {
    const saved = process.env[KEY];
    process.env[KEY] = "not-a-number";
    try {
      // Reporting NaN days would be worse than reporting the value actually in force.
      expect((await getAbout(seedBasic())).json().retention).toEqual({ versions_keep_days: 90, origin: "default" });
    } finally {
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
    }
  });
});

/**
 * Pricing (ADR-028). A model with no rate contributes $0 to every cost the UI shows, silently — this
 * block is what makes that visible, so the assertions that matter are "the store's unknown models are
 * named" and "a rejected override does not masquerade as an applied one".
 */
describe("about: pricing", () => {
  /** seedBasic already carries priced claude-opus-4-8 usage; each [model, input] adds one more row. */
  const seedUsage = (...models: Array<[string, number]>) => {
    const db = seedBasic();
    models.forEach(([model, input], i) => {
      const uuid = `ev-price-${i}`;
      addEvent(db, "sess1", uuid, { seq: 10 + i, role: "assistant", model });
      addTokens(db, uuid, "sess1", model, { input });
    });
    return db;
  };

  it("reports the built-in table when no override is configured", async () => {
    const body = (await getAbout(seedBasic())).json();
    expect(body.pricing.origin).toBe("default");
    expect(body.pricing.models).toBe(Object.keys(PRICE_TABLE).length);
    expect(body.pricing.applied).toEqual([]);
    expect(body.pricing.invalid).toEqual([]);
  });

  it("names models that have usage but no rate", async () => {
    const body = (await getAbout(seedUsage(["claude-opus-5", 100], ["claude-zeta-9", 100]))).json();
    expect(body.pricing.unpriced).toEqual(["claude-zeta-9"]);
  });

  it("does not report <synthetic>, which never had an API cost", async () => {
    const body = (await getAbout(seedUsage(["<synthetic>", 500]))).json();
    expect(body.pricing.unpriced).toEqual([]);
  });

  it("ignores a model row with no tokens — nothing is being understated", async () => {
    const body = (await getAbout(seedUsage(["claude-zeta-9", 0]))).json();
    expect(body.pricing.unpriced).toEqual([]);
  });

  it("reports the applied overrides the process started with, and stops flagging them", async () => {
    const ctx = { ...CTX, pricing: resolvePricing({ pricing: { "claude-zeta-9": { input: 1, output: 2 } } }) };
    // The route reports the startup table; the cost path reads the same one via usePricing.
    usePricing(ctx.pricing.table);
    try {
      const body = (await getAbout(seedUsage(["claude-zeta-9", 100]), ctx)).json();
      expect(body.pricing.origin).toBe("file");
      expect(body.pricing.applied).toEqual(["claude-zeta-9"]);
      expect(body.pricing.unpriced).toEqual([]);
    } finally {
      usePricing(PRICE_TABLE);
    }
  });

  it("surfaces a malformed override as ignored, not applied", async () => {
    const ctx = { ...CTX, pricing: resolvePricing({ pricing: { "claude-zeta-9": { output: 2 } } }) };
    const body = (await getAbout(seedUsage(["claude-zeta-9", 100]), ctx)).json();
    expect(body.pricing.invalid).toEqual(["claude-zeta-9"]);
    expect(body.pricing.applied).toEqual([]);
    expect(body.pricing.origin).toBe("default");
    expect(body.pricing.unpriced).toEqual(["claude-zeta-9"]); // still unpriced — the override never took
  });

  it("survives a DB with no token_usage table", async () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    db.exec("DROP TABLE token_usage");
    const res = await getAbout(db);
    expect(res.statusCode).toBe(200);
    expect(res.json().pricing.unpriced).toEqual([]);
  });
});

describe("about: storage", () => {
  it("sums ingested bytes from ingest_state, with the ingest time that bounds them", async () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO ingest_state (file_path, size, mtime_ms, sha256, events_ingested, ingested_at) VALUES (?,?,?,?,?,?)",
    ).run("/a.jsonl", 1000, 1, "h1", 5, "2026-07-01T00:00:00Z");
    db.prepare(
      "INSERT INTO ingest_state (file_path, size, mtime_ms, sha256, events_ingested, ingested_at) VALUES (?,?,?,?,?,?)",
    ).run("/b.jsonl", 2500, 2, "h2", 7, "2026-07-02T00:00:00Z");

    const body = (await getAbout(db)).json();
    expect(body.storage.archive_bytes).toBe(3500);
    expect(body.storage.archive_files).toBe(2);
    expect(body.storage.last_ingested).toBe("2026-07-02T00:00:00Z"); // MAX, not the first row
  });

  it("reports zero — not null — when nothing has been ingested", async () => {
    // SUM() over zero rows is NULL in SQLite; leaking that as null would render as "null bytes".
    const body = (await getAbout(freshDb())).json();
    expect(body.storage.archive_bytes).toBe(0);
    expect(body.storage.archive_files).toBe(0);
    expect(body.storage.last_ingested).toBeNull();
  });

  it("survives a pre-ingest DB with no ingest_state table at all", async () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    db.exec("DROP TABLE ingest_state");
    const res = await getAbout(db);
    expect(res.statusCode).toBe(200);
    expect(res.json().storage.archive_bytes).toBe(0);
  });

  it("reports db_bytes as null when the db path does not exist", async () => {
    // CTX points at /tmp/nowhere/custom.db — an in-memory DB has no file to stat.
    expect((await getAbout(seedBasic())).json().storage.db_bytes).toBeNull();
  });
});
