/**
 * PRs and pushed branches on the session detail, and the session list's `?pr=` filter (ADR-041).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { addSession, appFor, freshDb } from "./helpers/seed.js";
import { prFilter } from "../dist/db/sessions.js";

const GH = "https://github.com/demo/acme-api/pull/42";

function seed() {
  const db = freshDb();
  addSession(db, "s-gh");
  addSession(db, "s-other-repo");
  addSession(db, "s-none");
  const pr = db.prepare("INSERT INTO session_prs (session_id, repository, number, url, first_seen_at, opened_here) VALUES (?, ?, ?, ?, ?, ?)");
  pr.run("s-gh", "demo/acme-api", 42, GH, "2026-04-01T00:02:00Z", 1);
  pr.run("s-gh", "demo/web", 3, null, "2026-04-01T00:01:00Z", 0);
  pr.run("s-other-repo", "demo/other", 42, null, null, 0);
  db.prepare("INSERT INTO session_branches (session_id, branch, first_pushed_at) VALUES (?, ?, ?)").run("s-gh", "feat/x", "2026-04-01T00:00:30Z");
  return db;
}

let app: Awaited<ReturnType<typeof appFor>>;
beforeAll(async () => {
  app = await appFor(seed());
});

const ids = async (pr: string) =>
  ((await app.inject({ method: "GET", url: `/api/sessions?pr=${encodeURIComponent(pr)}` })).json().sessions as Array<{ id: string }>)
    .map((s) => s.id)
    .sort();

describe("session PR links", () => {
  it("lists the session's PRs (oldest sighting first) and pushed branches", async () => {
    const body = (await app.inject({ method: "GET", url: "/api/sessions/s-gh" })).json();
    expect(body.prs).toEqual([
      { repository: "demo/web", number: 3, url: null, first_seen_at: "2026-04-01T00:01:00Z", opened_here: false },
      { repository: "demo/acme-api", number: 42, url: GH, first_seen_at: "2026-04-01T00:02:00Z", opened_here: true },
    ]);
    expect(body.branches).toEqual([{ branch: "feat/x", first_pushed_at: "2026-04-01T00:00:30Z" }]);
  });

  it("returns empty lists for a session without any", async () => {
    const body = (await app.inject({ method: "GET", url: "/api/sessions/s-none" })).json();
    expect(body.prs).toEqual([]);
    expect(body.branches).toEqual([]);
  });

  it("filters the list by number (any repo), owner/repo#n, or URL", async () => {
    expect(await ids("42")).toEqual(["s-gh", "s-other-repo"]);
    expect(await ids("#42")).toEqual(["s-gh", "s-other-repo"]);
    expect(await ids("demo/acme-api#42")).toEqual(["s-gh"]);
    expect(await ids(GH)).toEqual(["s-gh"]);
    expect(await ids(GH + "/")).toEqual(["s-gh"]);
  });

  it("matches nothing for a value that is not a PR reference", async () => {
    expect(await ids("not-a-pr")).toEqual([]);
    expect(prFilter("javascript:1")).toBeNull();
  });

  it("serves a pre-v18 store: empty lists, and a pr filter matches nothing", async () => {
    const db = seed();
    db.exec("DROP TABLE session_prs; DROP TABLE session_branches;");
    const old = await appFor(db);
    const body = (await old.inject({ method: "GET", url: "/api/sessions/s-gh" })).json();
    expect(body.prs).toEqual([]);
    expect(body.branches).toEqual([]);
    const r = await old.inject({ method: "GET", url: "/api/sessions?pr=42" });
    expect(r.statusCode).toBe(200);
    expect(r.json().total).toBe(0);
  });
});
