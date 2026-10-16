/**
 * The dashboard endpoints answer from memory until the store changes. Their aggregates take ~1.3 s
 * together on the real store and only change when an ingest commits, so a revisit, a filter flipped
 * back or a second tab need not recompute them. `PRAGMA data_version` moves on every commit made by
 * another connection, which is the only kind a read-only handle sees, so it decides staleness.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { SCHEMA_SQL } from "@agent-lens/core";
import { openReadonly } from "../dist/db.js";
import { AGENT, SOURCE, addSession, addSource, appFor } from "./helpers/seed.js";

let dir: string;
let writer: DatabaseSync;
let reader: DatabaseSync;
let app: FastifyInstance;
let prepares: number;

const sessions = async (query = "") =>
  (await app.inject({ url: `/api/dashboard/overview${query}` })).json().sessions as number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "al-cache."));
  const file = join(dir, "store.db");
  writer = new DatabaseSync(file);
  writer.exec("PRAGMA journal_mode = WAL");
  writer.exec(SCHEMA_SQL);
  writer.prepare("INSERT INTO agents (id, name, kind) VALUES (?, 'Claude Code CLI', 'cli')").run(AGENT);
  addSource(writer, SOURCE);
  addSession(writer, "s1", { startedAt: "2026-01-01T00:00:00Z" });
  reader = openReadonly(file);
  const prepare = reader.prepare.bind(reader);
  prepares = 0;
  reader.prepare = ((sql: string) => (prepares++, prepare(sql))) as typeof reader.prepare;
  app = await appFor(reader);
});
afterEach(async () => {
  await app.close();
  reader.close();
  writer.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("dashboard response cache", () => {
  it("answers a repeated request without querying the store", async () => {
    expect(await sessions()).toBe(1);
    const after = prepares;
    expect(await sessions()).toBe(1);
    expect(prepares).toBe(after);
  });

  it("recomputes after another connection commits", async () => {
    expect(await sessions()).toBe(1);
    addSession(writer, "s2");
    expect(await sessions()).toBe(2);
  });

  it("keys on the query string", async () => {
    addSession(writer, "s2", { startedAt: "2026-03-01T00:00:00Z" });
    expect(await sessions()).toBe(2);
    expect(await sessions("?from=2026-02-01")).toBe(1);
  });
});
