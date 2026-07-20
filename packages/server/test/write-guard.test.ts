/**
 * Write-guard hardening (security-audit 2026-07-18): LOW-001 (Sec-Fetch-Site defense-in-depth on
 * top of the Origin allowlist) and LOW-002 (baseline security headers on every response).
 */
import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "@agent-lens/core";
import { createApp } from "../dist/app.js";
import { writeBlocked, originAllowed } from "../dist/refresh.js";

function db(): Database.Database {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  d.exec(SCHEMA_SQL);
  return d;
}
let app: Awaited<ReturnType<typeof createApp>>;
beforeAll(async () => {
  app = await createApp(db());
  await app.ready();
});

describe("writeBlocked — Origin allowlist + Sec-Fetch-Site (LOW-001)", () => {
  it("blocks cross-site / same-site fetches even when Origin is absent", () => {
    expect(writeBlocked({ "sec-fetch-site": "cross-site" })).toBe(true);
    expect(writeBlocked({ "sec-fetch-site": "same-site" })).toBe(true);
  });
  it("allows same-origin and user-initiated (none) browser writes", () => {
    expect(writeBlocked({ "sec-fetch-site": "same-origin" })).toBe(false);
    expect(writeBlocked({ "sec-fetch-site": "none" })).toBe(false);
  });
  it("allows non-browser callers (no Origin, no Sec-Fetch-Site — curl/CLI)", () => {
    expect(writeBlocked({})).toBe(false);
  });
  it("still blocks a cross-origin Origin (unchanged behavior)", () => {
    expect(writeBlocked({ origin: "https://evil.example" })).toBe(true);
    expect(writeBlocked({ origin: "http://127.0.0.1:4477" })).toBe(false);
    expect(originAllowed(undefined)).toBe(true); // the gap Sec-Fetch-Site now backs up
  });
});

describe("POST /api/refresh guard rejects before doing work", () => {
  it("403s a cross-site Sec-Fetch-Site (no real collect/ingest runs)", async () => {
    const r = await app.inject({ method: "POST", url: "/api/refresh", headers: { host: "127.0.0.1", "sec-fetch-site": "cross-site" } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("FORBIDDEN_ORIGIN");
  });
});

describe("baseline security headers (LOW-002)", () => {
  it("sets anti-clickjacking + nosniff + referrer headers on responses", async () => {
    const r = await app.inject({ method: "GET", url: "/api/health", headers: { host: "127.0.0.1" } });
    expect(r.statusCode).toBe(200);
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });
});
