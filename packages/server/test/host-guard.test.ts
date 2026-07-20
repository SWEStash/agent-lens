/**
 * HIGH-001 (security-audit 2026-07-18) — DNS-rebinding defense. The read-only server must reject any
 * request whose Host authority is not loopback, so a rebound `evil.com:4477` page can't read local
 * session data. Enforced by a global onRequest hook; opt-out only via the intentional non-local bind.
 */
import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "@agent-lens/core";
import { createApp } from "../dist/app.js";

function db(): Database.Database {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  d.exec(SCHEMA_SQL);
  return d;
}

let app: Awaited<ReturnType<typeof createApp>>;
let openApp: Awaited<ReturnType<typeof createApp>>;
beforeAll(async () => {
  app = await createApp(db());
  await app.ready();
  openApp = await createApp(db(), { enforceLoopbackHost: false });
  await openApp.ready();
});

const health = (a: typeof app, host?: string) =>
  a.inject({ method: "GET", url: "/api/health", headers: host === undefined ? {} : { host } });

describe("Host-header allowlist (DNS-rebinding guard)", () => {
  it("rejects a non-loopback Host with 403", async () => {
    const r = await health(app, "evil.com:4477");
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("FORBIDDEN_HOST");
  });

  it("rejects a bare attacker hostname", async () => {
    expect((await health(app, "attacker.example")).statusCode).toBe(403);
  });

  it("allows loopback authorities (with or without port)", async () => {
    for (const h of ["127.0.0.1:4477", "127.0.0.1", "localhost", "localhost:4477", "[::1]:4477", "[::1]"]) {
      expect((await health(app, h)).statusCode).toBe(200);
    }
  });

  it("when enforceLoopbackHost is false (AGENT_LENS_ALLOW_NONLOCAL), any Host is allowed", async () => {
    expect((await health(openApp, "my-lan-box.local:4477")).statusCode).toBe(200);
  });
});
