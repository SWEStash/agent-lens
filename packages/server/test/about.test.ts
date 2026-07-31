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
import { SCHEMA_SQL } from "@agent-lens/core";
import { appFor, freshDb, seedBasic } from "./helpers/seed";

const CTX = {
  db: { path: "/tmp/nowhere/custom.db", origin: "flag" as const },
  host: "127.0.0.1",
  port: 4477,
  loopbackOnly: true,
  repoRoot: null,
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

  it("reports an unstamped DB as null, and not as stale", async () => {
    // A DB that predates the stamp isn't known-old, it's unknown — claiming "stale" would send the
    // user to run a full re-ingest on no evidence.
    const body = (await getAbout(seedBasic())).json();
    expect(body.versions.schema).toBeNull();
    expect(body.versions.schema_stale).toBe(false);
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
