/**
 * UI preferences store — a key→JSON table on the writable sidecar (ADR-018 pattern), so chart/column
 * visibility survives a cache-clear. Writes reuse the CSRF + availability guard; reads degrade to null
 * when no writable store is configured, which is what lets the client keep its localStorage value
 * (and what makes the static snapshot build work at all).
 */
import { describe, it, expect } from "vitest";
import { appFor, seedBasic } from "./helpers/seed";

const KEY = "/api/prefs/dashboard.charts";
const sameOrigin = { origin: "http://localhost", "content-type": "application/json" };

const appWithPrefs = () => appFor(seedBasic(), { triageDbPath: ":memory:" });

describe("UI prefs store", () => {
  it("GET unset → null; PUT (same-origin) then GET round-trips the JSON", async () => {
    const app = await appWithPrefs();
    let r = await app.inject({ method: "GET", url: KEY });
    expect(r.statusCode).toBe(200);
    expect(r.json().value).toBeNull();

    r = await app.inject({ method: "PUT", url: KEY, headers: sameOrigin, payload: { value: ["cost-over-time", "activity"] } });
    expect(r.statusCode).toBe(200);

    r = await app.inject({ method: "GET", url: KEY });
    expect(r.json().value).toEqual(["cost-over-time", "activity"]);
    await app.close();
  });

  it("PUT blocks a cross-site Origin (CSRF guard)", async () => {
    const app = await appWithPrefs();
    const r = await app.inject({
      method: "PUT",
      url: KEY,
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      payload: { value: [] },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("FORBIDDEN_ORIGIN");
    await app.close();
  });

  it("rejects an invalid pref key", async () => {
    const app = await appWithPrefs();
    const r = await app.inject({ method: "GET", url: "/api/prefs/" + encodeURIComponent("bad key!") });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it("degrades to null (GET) and 503 (PUT) when no writable store is configured", async () => {
    const app = await appFor(seedBasic()); // no triageDbPath
    const g = await app.inject({ method: "GET", url: KEY });
    expect(g.statusCode).toBe(200);
    expect(g.json().value).toBeNull();

    const w = await app.inject({ method: "PUT", url: KEY, headers: sameOrigin, payload: { value: [] } });
    expect(w.statusCode).toBe(503);
    await app.close();
  });
});
