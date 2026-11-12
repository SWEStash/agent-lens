/**
 * How each tool call was approved (ADR-040, #76): the server projects the permission columns as one
 * `permission` object (null when not recorded) on findings and session tool calls, and the findings
 * list + bulk dismiss filter by `approval=`. The approval buckets partition the findings: each
 * finding falls in exactly one.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "@agent-lens/core";
import { createApp } from "../dist/app.js";

function seed(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(SCHEMA_SQL);
  db.exec(`
    INSERT INTO agents (id, name, kind) VALUES ('claude-code','Claude Code CLI','cli');
    INSERT INTO sources (id, label, agent_id) VALUES ('personal','personal','claude-code');
    INSERT INTO projects (id, agent_id, path) VALUES ('proj1','claude-code','/demo/acme');
    INSERT INTO sessions (id, agent_id, source_id, project_id, ai_title, is_sidechain, started_at, event_count, turn_count)
      VALUES ('sess1','claude-code','personal','proj1','Risky session',0,'2026-07-10T00:00:00Z',4,1);
    INSERT INTO events (uuid, session_id, type, role, timestamp, raw_json) VALUES
      ('e1','sess1','assistant','assistant','2026-07-10T00:00:01Z','{}'),('e2','sess1','assistant','assistant','2026-07-10T00:00:02Z','{}'),
      ('e3','sess1','assistant','assistant','2026-07-10T00:00:03Z','{}'),('e4','sess1','assistant','assistant','2026-07-10T00:00:04Z','{}');
    INSERT INTO tool_calls (id, event_uuid, session_id, tool_name, permission_decision, permission_via, permission_scope, permission_rule_source, permission_reason) VALUES
      ('tc-cls','e1','sess1','Bash','accept','classifier',NULL,NULL,NULL),
      ('tc-usr','e2','sess1','Bash','accept','user','once','localSettings',NULL),
      ('tc-rej','e3','sess1','Bash','reject','hook',NULL,NULL,'hook:PreToolUse'),
      ('tc-old','e4','sess1','Bash',NULL,NULL,NULL,NULL,NULL);
    INSERT INTO findings (id, session_id, tool_call_id, event_uuid, rule_id, category, framework_ref, severity, title, evidence, signals_json, detector_version) VALUES
      ('f-cls','sess1','tc-cls','e1','destructive.rm_rf','destructive','OWASP','high','rm','rm -rf x','{}',10),
      ('f-usr','sess1','tc-usr','e2','destructive.rm_rf','destructive','OWASP','high','rm','rm -rf y','{}',10),
      ('f-rej','sess1','tc-rej','e3','destructive.rm_rf','destructive','OWASP','medium','rm','rm -rf z','{}',10),
      ('f-old','sess1','tc-old','e4','destructive.rm_rf','destructive','OWASP','high','rm','rm -rf w','{}',10);
  `);
  return db;
}

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "al-perm."));
  app = await createApp(seed(), { triageDbPath: join(root, "triage.db") });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

const get = async (url: string) => JSON.parse((await app.inject({ method: "GET", url })).body);
const ids = (page: any) => (page.findings as Array<{ id: string }>).map((f) => f.id).sort();

describe("permission on findings", () => {
  it("projects the columns as one object, null when not recorded", async () => {
    const byId = Object.fromEntries((await get("/api/security/findings")).findings.map((f: any) => [f.id, f.permission]));
    expect(byId["f-usr"]).toEqual({ decision: "accept", via: "user", scope: "once", rule_source: "localSettings", reason: null });
    expect(byId["f-rej"]).toEqual({ decision: "reject", via: "hook", scope: null, rule_source: null, reason: "hook:PreToolUse" });
    expect(byId["f-old"]).toBeNull();
  });

  it("filters by how the call was approved", async () => {
    expect(ids(await get("/api/security/findings?approval=classifier"))).toEqual(["f-cls"]);
    expect(ids(await get("/api/security/findings?approval=user"))).toEqual(["f-usr"]);
    expect(ids(await get("/api/security/findings?approval=rejected"))).toEqual(["f-rej"]);
    expect(ids(await get("/api/security/findings?approval=unknown"))).toEqual(["f-old"]);
    // A channel filter means approved through it: the hook-rejected call is not "approved by hook".
    expect(ids(await get("/api/security/findings?approval=hook"))).toEqual([]);
    expect((await get("/api/security/findings?approval=rejected")).total).toBe(1);
  });

  it("ignores an unknown approval value instead of matching nothing", async () => {
    expect(ids(await get("/api/security/findings?approval=bogus"))).toHaveLength(4);
  });

  it("bulk dismiss honours the same filter", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/security/dismiss-matching",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ filter: { approval: "unknown" } }),
    });
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, dismissed: 1 });
    expect(ids(await get("/api/security/findings"))).toEqual(["f-cls", "f-rej", "f-usr"]);
  });
});

describe("permission on session tool calls", () => {
  it("ships the object on each tool call", async () => {
    const d = await get("/api/sessions/sess1");
    const calls = d.events.flatMap((e: any) => e.toolCalls ?? []);
    const by = Object.fromEntries(calls.map((t: any) => [t.id, t.permission]));
    expect(by["tc-cls"]).toEqual({ decision: "accept", via: "classifier", scope: null, rule_source: null, reason: null });
    expect(by["tc-old"]).toBeNull();
  });
});

describe("a store from before the permission columns (schema v16)", () => {
  it("still serves findings and sessions, with permission null, until it is rebuilt", async () => {
    const db = seed();
    for (const c of ["permission_decision", "permission_via", "permission_scope", "permission_rule_source", "permission_reason"])
      db.exec(`ALTER TABLE tool_calls DROP COLUMN ${c}`);
    const old = await createApp(db, {});
    await old.ready();
    const list = await old.inject({ method: "GET", url: "/api/security/findings?approval=rejected" });
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.body).findings).toEqual([]); // nothing is recorded, so nothing was rejected
    const all = JSON.parse((await old.inject({ method: "GET", url: "/api/security/findings" })).body);
    expect(all.findings.every((f: any) => f.permission === null)).toBe(true);
    const detail = await old.inject({ method: "GET", url: "/api/sessions/sess1" });
    expect(detail.statusCode).toBe(200);
    await old.close();
  });
});
