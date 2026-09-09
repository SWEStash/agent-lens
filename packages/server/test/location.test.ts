/**
 * GET /api/sessions/:id/location — the archive path behind the session page's "Copy archive path"
 * button. The path is not stored on `sessions`; it is recovered from `events.source_file`, which a
 * session can carry more than one of (retention snapshots under `.versions/`), so picking the live,
 * canonically-named file is the behaviour worth pinning.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addEvent, addSession, appFor, freshDb } from "./helpers/seed.js";

const ARCHIVE = "/data/archive/test/projects/-tmp-proj";

describe("GET /api/sessions/:id/location", () => {
  it("returns the archived transcript path for a session", async () => {
    const db = freshDb();
    addSession(db, "sess1");
    addEvent(db, "sess1", "e1", { sourceFile: `${ARCHIVE}/sess1.jsonl` });
    const app = await appFor(db);
    const r = await app.inject({ method: "GET", url: "/api/sessions/sess1/location" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      session_id: "sess1",
      path: `${ARCHIVE}/sess1.jsonl`,
      exists: false, // the seeded path is fictional — see the on-disk case below
      source_id: "test",
    });
    await app.close();
  });

  it("prefers the live copy over a .versions/ retention snapshot", async () => {
    const db = freshDb();
    addSession(db, "sess1");
    addEvent(db, "sess1", "e1", { sourceFile: `/data/archive/test/.versions/2026-01-01/projects/-tmp-proj/sess1.jsonl` });
    addEvent(db, "sess1", "e2", { seq: 1, sourceFile: `${ARCHIVE}/sess1.jsonl` });
    const app = await appFor(db);
    const r = await app.inject({ method: "GET", url: "/api/sessions/sess1/location" });
    expect(r.json().path).toBe(`${ARCHIVE}/sess1.jsonl`);
    await app.close();
  });

  it("reports whether the file is still on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-lens-loc-"));
    const file = join(dir, "sess1.jsonl");
    writeFileSync(file, "{}\n");
    const db = freshDb();
    addSession(db, "sess1");
    addEvent(db, "sess1", "e1", { sourceFile: file });
    const app = await appFor(db);
    const r = await app.inject({ method: "GET", url: "/api/sessions/sess1/location" });
    expect(r.json()).toMatchObject({ path: file, exists: true });
    await app.close();
  });

  it("404s when no event carries a source_file (nothing to point at)", async () => {
    const db = freshDb();
    addSession(db, "sess1");
    addEvent(db, "sess1", "e1");
    const app = await appFor(db);
    const r = await app.inject({ method: "GET", url: "/api/sessions/sess1/location" });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("NOT_FOUND");
    await app.close();
  });

  it("404s for an unknown session", async () => {
    const app = await appFor(freshDb());
    const r = await app.inject({ method: "GET", url: "/api/sessions/nope/location" });
    expect(r.statusCode).toBe(404);
    await app.close();
  });
});
