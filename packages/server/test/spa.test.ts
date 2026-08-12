/**
 * Static SPA serving: which unmatched paths get index.html back, and which must 404.
 *
 * The distinction is not cosmetic. A tab that outlived a rebuild asks for a hashed chunk the new
 * dist no longer contains; answering that with index.html hands the browser HTML where it expects
 * a module, which it rejects on MIME grounds — the SPA then dies with a module-load error instead
 * of a plain 404 it can recognize as "this document is stale".
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { appFor, seedBasic } from "./helpers/seed";

let app: Awaited<ReturnType<typeof appFor>>;

beforeAll(async () => {
  const webDist = mkdtempSync(join(tmpdir(), "agent-lens-webdist-"));
  writeFileSync(join(webDist, "index.html"), "<!doctype html><title>Agent Lens</title>");
  mkdirSync(join(webDist, "assets"));
  writeFileSync(join(webDist, "assets", "index-current.js"), "export default 1;\n");
  app = await appFor(seedBasic(), { webDist });
});

afterAll(async () => {
  await app.close();
});

describe("SPA static serving", () => {
  it("serves a real asset", async () => {
    const r = await app.inject({ method: "GET", url: "/assets/index-current.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("export default");
  });

  it("falls back to index.html for a client route", async () => {
    const r = await app.inject({ method: "GET", url: "/session/sess1" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/html");
    expect(r.body).toContain("Agent Lens");
  });

  it("404s a missing chunk instead of answering it with index.html", async () => {
    const r = await app.inject({ method: "GET", url: "/assets/SessionView-stale.js" });
    expect(r.statusCode).toBe(404);
    expect(r.headers["content-type"]).not.toContain("text/html");
    expect(r.json().error.code).toBe("NOT_FOUND");
  });

  it("404s a missing file on any path, query string and all", async () => {
    const r = await app.inject({ method: "GET", url: "/favicon-32.png?v=2" });
    expect(r.statusCode).toBe(404);
  });

  it("still 404s the API in its own envelope", async () => {
    const r = await app.inject({ method: "GET", url: "/api/nope" });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("NOT_FOUND");
  });
});
