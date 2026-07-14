/**
 * Security triage (ADR-018) — dismiss / reopen / mute / unmute over a separate writable triage.db that
 * createApp ATTACHes to the read handle. Seeds a minimal findings graph, drives the real routes with
 * app.inject (no socket), and asserts the open/dismissed/muted views + the CSRF guard. Imports the
 * BUILT dist (matches the other server suites).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "@agent-lens/core";
import { createApp } from "../dist/app.js";

/** Seed sessions + tool_calls + three findings (critical exfil, high + medium privilege). */
function seed(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF"); // we test triage SQL, not referential integrity
  db.exec(SCHEMA_SQL);
  db.exec(`
    INSERT INTO agents (id, name, kind) VALUES ('claude-code','Claude Code CLI','cli');
    INSERT INTO sources (id, label, agent_id) VALUES ('personal','personal','claude-code');
    INSERT INTO projects (id, agent_id, path) VALUES ('proj1','claude-code','/demo/acme');
    INSERT INTO sessions (id, agent_id, source_id, project_id, ai_title, is_sidechain, started_at, event_count, turn_count)
      VALUES ('sess1','claude-code','personal','proj1','Risky session',0,'2026-07-10T00:00:00Z',2,1);
    INSERT INTO tool_calls (id, session_id, tool_name) VALUES ('tc1','sess1','Bash'),('tc2','sess1','Write');
    INSERT INTO findings (id, session_id, tool_call_id, event_uuid, rule_id, category, framework_ref, severity, title, evidence, signals_json, detector_version) VALUES
      ('f-crit','sess1','tc1','e1','exfil.network_upload','exfiltration','MITRE ATLAS AML.T0086','critical','Uploads data','curl ...','{}',2),
      ('f-high','sess1','tc2','e2','privilege.write_outside_project','privilege-bypass','OWASP LLM06','high','Writes outside project','/etc/x','{}',2),
      ('f-med','sess1','tc1','e1','privilege.sudo','privilege-bypass','OWASP LLM06','medium','Runs as root','sudo x','{}',2);
  `);
  return db;
}

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "al-triage."));
  app = await createApp(seed(), { triageDbPath: join(root, "triage.db") });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

const get = async (url: string) => JSON.parse((await app.inject({ method: "GET", url })).body);
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, headers: { "content-type": "application/json", ...headers }, payload: JSON.stringify(body) });
const ids = (page: any) => (page.findings as Array<{ id: string }>).map((f) => f.id).sort();

describe("triage: dismiss / reopen", () => {
  it("open view hides dismissed; dismissed view shows them; reopen restores", async () => {
    expect(ids(await get("/api/security/findings"))).toEqual(["f-crit", "f-high", "f-med"]);

    const r = await post("/api/security/dismiss", { ids: ["f-med"], note: "benign in dev" });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, dismissed: 1 });

    expect(ids(await get("/api/security/findings"))).toEqual(["f-crit", "f-high"]); // open excludes it
    const dismissed = await get("/api/security/findings?status=dismissed");
    expect(ids(dismissed)).toEqual(["f-med"]);
    expect(dismissed.findings[0].dismiss_note).toBe("benign in dev");

    await post("/api/security/reopen", { ids: ["f-med"] });
    expect(ids(await get("/api/security/findings"))).toEqual(["f-crit", "f-high", "f-med"]);
  });

  it("dismiss-matching clears every open finding for a filter", async () => {
    const r = await post("/api/security/dismiss-matching", { filter: { category: "privilege-bypass" } });
    expect(JSON.parse(r.body).dismissed).toBe(2); // f-high + f-med
    expect(ids(await get("/api/security/findings"))).toEqual(["f-crit"]);
  });
});

describe("triage: rule mute", () => {
  it("muting a rule hides its findings from open + summary; mutes list + unmute restore", async () => {
    await post("/api/security/mute", { rule_id: "privilege.sudo", scope: "global", note: "always noise" });
    expect(ids(await get("/api/security/findings"))).toEqual(["f-crit", "f-high"]);
    expect(ids(await get("/api/security/findings?status=muted"))).toEqual(["f-med"]);

    const sum = await get("/api/security/summary");
    expect(sum.total).toBe(2); // open only
    expect(sum.muted).toBe(1);
    expect(sum.by_severity.find((s: any) => s.severity === "medium")).toBeUndefined();

    const mutes = await get("/api/security/mutes");
    expect(mutes).toHaveLength(1);
    expect(mutes[0]).toMatchObject({ rule_id: "privilege.sudo", scope: "global" });

    await post("/api/security/unmute", { rule_id: "privilege.sudo", scope: "global" });
    expect(ids(await get("/api/security/findings"))).toEqual(["f-crit", "f-high", "f-med"]);
  });

  it("project-scoped mute only suppresses in the matching project", async () => {
    await post("/api/security/mute", { rule_id: "privilege.sudo", scope: "project", scope_id: "proj1" });
    expect(ids(await get("/api/security/findings"))).toEqual(["f-crit", "f-high"]);
    await post("/api/security/unmute", { rule_id: "privilege.sudo", scope: "project", scope_id: "other" });
    // Unmuting a different project leaves the proj1 mute in place.
    expect(ids(await get("/api/security/findings"))).toEqual(["f-crit", "f-high"]);
  });
});

describe("triage: filters & summary", () => {
  it("date range + status=all + source filter narrow the list", async () => {
    expect(ids(await get("/api/security/findings?from=2026-07-01&to=2026-07-31"))).toEqual(["f-crit", "f-high", "f-med"]);
    expect((await get("/api/security/findings?from=2026-08-01")).findings).toHaveLength(0);
    expect(ids(await get("/api/security/findings?source=personal&status=all"))).toEqual(["f-crit", "f-high", "f-med"]);
  });

  it("the `to` bound is date-inclusive (selecting the finding's own day includes it)", async () => {
    // Findings are dated 2026-07-10; to=2026-07-10 must INCLUDE them (regression: was off-by-one).
    expect(ids(await get("/api/security/findings?to=2026-07-10"))).toEqual(["f-crit", "f-high", "f-med"]);
    expect(ids(await get("/api/security/findings?from=2026-07-10&to=2026-07-10"))).toEqual(["f-crit", "f-high", "f-med"]);
    expect((await get("/api/security/findings?to=2026-07-09")).findings).toHaveLength(0);
  });

  it("list rows carry the tool name (clarifies path-only evidence)", async () => {
    const page = await get("/api/security/findings?status=all");
    expect(page.findings.find((f: any) => f.id === "f-high").tool_name).toBe("Write");
    expect(page.findings.find((f: any) => f.id === "f-crit").tool_name).toBe("Bash");
  });

  it("summary counts are over open findings, with dismissed/muted totals alongside", async () => {
    await post("/api/security/dismiss", { ids: ["f-crit"] });
    const sum = await get("/api/security/summary");
    expect(sum.total).toBe(2);
    expect(sum.dismissed).toBe(1);
    expect(sum.muted).toBe(0);
  });
});

describe("triage: CSRF guard", () => {
  it("rejects a cross-origin write with 403 and does not mutate", async () => {
    const r = await post("/api/security/dismiss", { ids: ["f-crit"] }, { origin: "https://evil.example" });
    expect(r.statusCode).toBe(403);
    expect(ids(await get("/api/security/findings"))).toEqual(["f-crit", "f-high", "f-med"]);
  });
});
