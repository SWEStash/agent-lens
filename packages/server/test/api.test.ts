/**
 * Server API over an in-memory DB, exercised through app.inject() (no socket bound).
 *
 * Covers the read paths the SPA depends on — sessions list/detail, search, sources, health — plus the
 * query-parameter boundaries, which are the parts a client can actually attack with garbage. The sort
 * ALLOWLIST itself is pinned in sql-util.test.ts; here we only assert that a bad value is refused
 * rather than reaching SQLite. Workflow fan-out lives in workflows.test.ts, prefs in prefs.test.ts.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { packRaw } from "@agent-lens/core";
import { extractParts } from "../dist/db.js";
import { addEvent, addSession, addSource, addTool, addTurn, appFor, freshDb, seedBasic } from "./helpers/seed";

let app: Awaited<ReturnType<typeof appFor>>;
beforeAll(async () => {
  app = await appFor(seedBasic());
});

describe("server API smoke", () => {
  it("GET /api/health → ok + last_ingested", async () => {
    const r = await app.inject({ method: "GET", url: "/api/health" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.ok).toBe(true);
    // last_ingested is MAX(ingest_state.ingested_at): an ISO string once ingested, null otherwise.
    expect(body).toHaveProperty("last_ingested");
    expect(body.last_ingested === null || typeof body.last_ingested === "string").toBe(true);
  });

  it("POST /api/refresh → blocks a cross-site Origin (CSRF guard) before doing any work", async () => {
    const r = await app.inject({ method: "POST", url: "/api/refresh", headers: { origin: "https://evil.example" } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("FORBIDDEN_ORIGIN");
  });

  it("GET /api/sessions → paginated list", async () => {
    const r = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.total).toBe(1);
    expect(body.sessions[0]).toMatchObject({ id: "sess1", title: "Demo session" });
  });

  it("GET /api/sessions/:id → transcript detail", async () => {
    const r = await app.inject({ method: "GET", url: "/api/sessions/sess1" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.session.id).toBe("sess1");
    expect(body.turns).toHaveLength(1);
    expect(body.events).toHaveLength(2);
    expect(body.parent).toBeNull(); // main session, no spawning parent
  });

  it("GET /api/sessions/:id → 404 for unknown id, with the structured error envelope", async () => {
    const r = await app.inject({ method: "GET", url: "/api/sessions/nope" });
    expect(r.statusCode).toBe(404);
    // Every not-found shares { error: { code, message } } so clients read err.error.code uniformly.
    expect(r.json().error.code).toBe("NOT_FOUND");
  });

  it("GET /api/dashboard/overview → aggregates", async () => {
    const r = await app.inject({ method: "GET", url: "/api/dashboard/overview" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ sessions: 1, total_tokens: 150 });
  });

  it("GET /api/dashboard/breakdowns → includes skills", async () => {
    const r = await app.inject({ method: "GET", url: "/api/dashboard/breakdowns" });
    expect(r.statusCode).toBe(200);
    expect(r.json().skills.some((s: { name: string }) => s.name === "test-suite-design")).toBe(true);
  });
});

describe("session search", () => {
  it("matches a plain term in the transcript text", async () => {
    const r = await app.inject({ method: "GET", url: "/api/sessions?q=hello" });
    expect(r.statusCode).toBe(200);
    expect(r.json().sessions[0].id).toBe("sess1");
  });

  it("treats FTS5 operators as literal input rather than query syntax", async () => {
    // A hyphen/colon used to be parsed as FTS5 syntax → `no such column` → 500. Input is quoted as a
    // phrase now, so "hello-world" matches the adjacent tokens "hello world".
    const hyphenated = await app.inject({ method: "GET", url: "/api/sessions?q=" + encodeURIComponent("hello-world") });
    expect(hyphenated.statusCode).toBe(200);
    expect(hyphenated.json().sessions[0].id).toBe("sess1");

    for (const q of ["foo:bar", "swe-workflow", "a OR b", "-x", '"', "*", "NEAR(a b)", "^x"]) {
      const r = await app.inject({ method: "GET", url: "/api/sessions?q=" + encodeURIComponent(q) });
      expect(r.statusCode, `q=${q}`).toBe(200); // literal terms; no match, but never a 500
    }
  });

  it("matches the session's own name, not just transcript text", async () => {
    // "Demo" is the ai_title and appears in NO event text (events say "hello world"/"hi").
    const r = await app.inject({ method: "GET", url: "/api/sessions?q=Demo" });
    expect(r.statusCode).toBe(200);
    expect(r.json().sessions.map((s: { id: string }) => s.id)).toContain("sess1");
  });

  it("matches the project path", async () => {
    // "proj" is only in the project path (/tmp/proj), never in the transcript.
    const r = await app.inject({ method: "GET", url: "/api/sessions?q=proj" });
    expect(r.statusCode).toBe(200);
    expect(r.json().sessions.map((s: { id: string }) => s.id)).toContain("sess1");
  });

  it("returns an empty page for a term nothing matches", async () => {
    const r = await app.inject({ method: "GET", url: "/api/sessions?q=zzzznotpresent" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ total: 0, sessions: [] });
  });
});

// Query params arrive from a URL, so every one of these is reachable by hand-editing the address bar.
// None may 500, and none may reach SQLite as a negative/unbounded LIMIT or OFFSET.
describe("query parameter boundaries", () => {
  const listOk = async (qs: string) => {
    const r = await app.inject({ method: "GET", url: "/api/sessions?" + qs });
    expect(r.statusCode, qs).toBe(200);
    const body = r.json();
    expect(Array.isArray(body.sessions), qs).toBe(true);
    return body;
  };

  it("ignores a non-numeric or negative offset", async () => {
    for (const qs of ["offset=-1", "offset=-99999", "offset=abc", "offset=", "offset=1e9"]) {
      const body = await listOk(qs);
      expect(body.sessions.length, qs).toBeLessThanOrEqual(1);
    }
  });

  it("caps an oversized limit and defaults a zero / non-numeric one", async () => {
    for (const qs of ["limit=0", "limit=999999", "limit=abc", "limit="]) {
      const body = await listOk(qs);
      expect(body.sessions.length, qs).toBeLessThanOrEqual(1);
    }
  });

  /* CHARACTERIZATION — these two pin what the code does TODAY, not what it should do. Both are real
   * defects found while adding this coverage (SLOP-042); they are fixed in the following commit, where
   * these expectations flip. Kept as executable documentation in between so the refactor commit stays
   * behaviour-preserving.
   *
   * `limit` and `offset` are parsed as `Math.min(Number(q.limit) || 50, 200)` / `Number(q.offset) || 0`
   * (app.ts). Neither guards the lower bound or integrality. */
  it("CHARACTERIZATION: a negative limit bypasses the page cap entirely", async () => {
    const db = freshDb();
    for (let i = 0; i < 250; i++) addSession(db, `s${i}`);
    const local = await appFor(db);

    // Math.min(-1, 200) = -1, and SQLite reads a negative LIMIT as "no limit" — so the 200-row cap is
    // gone and the whole table comes back in one response.
    const all = await local.inject({ method: "GET", url: "/api/sessions?limit=-1" });
    expect(all.json().sessions).toHaveLength(250);
    // For contrast, the cap does hold against an oversized positive limit.
    expect((await local.inject({ method: "GET", url: "/api/sessions?limit=999999" })).json().sessions).toHaveLength(200);
    await local.close();
  });

  it("CHARACTERIZATION: a non-integer offset 500s instead of being coerced", async () => {
    // Number("1.5") is truthy and non-integer, so it reaches better-sqlite3, which refuses to bind it.
    const r = await app.inject({ method: "GET", url: "/api/sessions?offset=1.5" });
    expect(r.statusCode).toBe(500);
  });

  it("does not 500 on an unknown sort key or direction", async () => {
    // The allowlist itself is pinned in sql-util.test.ts — this only asserts nothing reaches SQLite.
    for (const qs of ["sort=bogus", "sort=id;DROP TABLE sessions", "dir=sideways", "sort=&dir=", "sort=started_at&dir=ASC--"]) {
      const r = await app.inject({ method: "GET", url: "/api/sessions?" + qs });
      expect([200, 400], qs).toContain(r.statusCode);
    }
    // The table is still there.
    expect((await app.inject({ method: "GET", url: "/api/sessions" })).json().total).toBe(1);
  });

  it("falls back to the safe redaction level for a malformed ?redact", async () => {
    const base = await app.inject({ method: "GET", url: "/api/sessions/sess1/export.md" });
    expect(base.statusCode).toBe(200);
    for (const q of ["?redact=garbage", "?redact=", "?redact=OFF", "?redact=structure%00"]) {
      const r = await app.inject({ method: "GET", url: "/api/sessions/sess1/export.md" + q });
      expect(r.statusCode, q).toBe(200);
      // Anything unrecognized must land on the default, i.e. match the no-param response exactly.
      expect(r.body, q).toBe(base.body);
    }
  });

  it("serves the two recognized redaction levels distinctly", async () => {
    const def = await app.inject({ method: "GET", url: "/api/sessions/sess1/export.md" });
    const off = await app.inject({ method: "GET", url: "/api/sessions/sess1/export.md?redact=off" });
    const structure = await app.inject({ method: "GET", url: "/api/sessions/sess1/export.md?redact=structure" });
    for (const r of [off, structure]) expect(r.statusCode).toBe(200);
    // `off` is the explicit verbatim opt-out, so it must NOT equal the aggressive scrub.
    expect(structure.body).not.toBe(off.body);
    expect(def.body).not.toBe(structure.body);
  });

  it("rejects /api/file with no path instead of querying for everything", async () => {
    const r = await app.inject({ method: "GET", url: "/api/file" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("MISSING_PATH");
  });
});

// Stored JSON is written by the ingester, but a partial write or an older/newer schema can leave a
// row the read path still has to survive — degrade the one row, never fail the whole request.
describe("malformed stored JSON degrades instead of 500ing", () => {
  it("serves a session whose tool input_json and raw_json are not valid JSON", async () => {
    const db = freshDb();
    addSession(db, "bad", { events: 2, turns: 1 });
    const turn = addTurn(db, "bad", 0, { userEvent: "b1" });
    addEvent(db, "bad", "b1", { turn, seq: 0, role: "user", text: "hi", raw: "{not json at all" });
    addEvent(db, "bad", "b2", { turn, seq: 1, role: "assistant", raw: '{"message":{"content":[' });
    addTool(db, "bad", "b2", "tc_bad", "Bash", { turn, inputRaw: "{oops" });
    const local = await appFor(db);

    const r = await local.inject({ method: "GET", url: "/api/sessions/bad" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.session.id).toBe("bad");
    expect(body.events).toHaveLength(2);
    // The tool call still lists, even though its input could not be parsed.
    expect(body.events.flatMap((e: { toolCalls: unknown[] }) => e.toolCalls)).toHaveLength(1);
    await local.close();
  });

  it("lists and searches a session with malformed rows without erroring", async () => {
    const db = freshDb();
    addSession(db, "bad", { title: "Broken" });
    const turn = addTurn(db, "bad", 0, { userEvent: "b1" });
    addEvent(db, "bad", "b1", { turn, role: "user", text: "searchable", raw: "<<<not json>>>" });
    const local = await appFor(db);

    expect((await local.inject({ method: "GET", url: "/api/sessions" })).statusCode).toBe(200);
    expect((await local.inject({ method: "GET", url: "/api/sessions?q=searchable" })).statusCode).toBe(200);
    await local.close();
  });
});

// raw_json is stored gzip-compressed (ADR-011); the transcript read path must transparently decode it,
// while still tolerating legacy plain rows written before the migration.
describe("extractParts decodes stored raw_json (ADR-011)", () => {
  it("decompresses a gzip BLOB into text + thinking", () => {
    const line = JSON.stringify({ message: { content: [{ type: "text", text: "hi" }, { type: "thinking", thinking: "hmm" }] } });
    const { text, thinking } = extractParts(packRaw(line));
    expect(text).toBe("hi");
    expect(thinking).toBe("hmm");
  });

  it("still reads a legacy plain-string raw_json", () => {
    expect(extractParts('{"message":{"content":"plain"}}').text).toBe("plain");
  });
});

// Subagent metadata (session_meta) enriches the fan-out views: a subagent's authoritative type +
// human description + nesting depth, LEFT JOINed onto the children projection. A subagent with no
// meta row must still list, with nulls.
describe("session_meta enriches subagent rows", () => {
  it("GET /api/sessions/:id → children carry agent_type/agent_description/spawn_depth", async () => {
    const db = freshDb();
    addSession(db, "orch");
    addSession(db, "agent-a", { sidechain: true, parent: "orch" });
    addSession(db, "agent-b", { sidechain: true, parent: "orch" });
    db.prepare(
      `INSERT INTO session_meta (session_id, source_id, agent_type, agent_description, spawn_depth, tool_use_id, ingested_at)
       VALUES ('agent-a', 'test', 'Explore', 'Explore the ingest pipeline', 2, 'toolu_1', 'now')`,
    ).run();
    const local = await appFor(db);

    const body = (await local.inject({ method: "GET", url: "/api/sessions/orch" })).json();
    const children: Array<{ id: string }> = body.children;
    expect(children.find((c) => c.id === "agent-a")).toMatchObject({
      agent_type: "Explore",
      agent_description: "Explore the ingest pipeline",
      spawn_depth: 2,
    });
    expect(children.find((c) => c.id === "agent-b")).toMatchObject({ agent_type: null, agent_description: null, spawn_depth: null });
    await local.close();
  });
});

// Spilled tool outputs (tool_results): when a result_summary is the "Full output saved to: …" marker,
// getSession attaches the un-truncated text so the UI can expand it. The contract is "the marker
// triggers the lookup and the full text is attached" — not the specific byte count seeded here.
describe("getSession attaches spilled full tool results", () => {
  it("GET /api/sessions/:id → only the tool call with a truncation marker gets full_result", async () => {
    const db = freshDb();
    addSession(db, "sess1");
    const turn = addTurn(db, "sess1", 0, { userEvent: "e1" });
    addEvent(db, "sess1", "e2", { turn, seq: 1, role: "assistant", timestamp: "2026-01-01T00:00:30Z" });
    addTool(db, "sess1", "e2", "tc_big", "Bash", {
      turn,
      result:
        "Output too large (32.1KB). Full output saved to: /home/u/.claude/projects/-x/sess1/tool-results/bk7e5i18g.txt Preview (first 2KB): …",
    });
    addTool(db, "sess1", "e2", "tc_small", "Bash", { turn, result: "ok, small result" });
    db.prepare(
      `INSERT INTO tool_results (session_id, name, path, bytes, text, ingested_at)
       VALUES ('sess1', 'bk7e5i18g', '/archive/.../tool-results/bk7e5i18g.txt', 32900, 'THE FULL UNTRUNCATED OUTPUT', 'now')`,
    ).run();
    const local = await appFor(db);

    const body = (await local.inject({ method: "GET", url: "/api/sessions/sess1" })).json();
    const tools: Array<{ id: string; full_result?: { text: string } }> = body.events.flatMap(
      (e: { toolCalls: Array<{ id: string }> }) => e.toolCalls,
    );
    expect(tools.find((t) => t.id === "tc_big")?.full_result?.text).toBe("THE FULL UNTRUNCATED OUTPUT");
    expect(tools.find((t) => t.id === "tc_small")?.full_result).toBeUndefined(); // no marker → no lookup
    await local.close();
  });
});

// The source-filter dropdown shows "(N)" next to each source. N must be MAIN sessions only — the list
// it filters defaults to main-only, and each task spawns many subagent sidechains, so counting all
// sessions wildly inflates it (the reported 327-vs-27 bug).
describe("source session_count counts main sessions only", () => {
  it("GET /api/sources → excludes subagent sidechains", async () => {
    const db = freshDb({ source: "isf" });
    addSession(db, "m1", { source: "isf", events: 3 });
    for (const id of ["a1", "a2", "a3"]) addSession(db, id, { source: "isf", sidechain: true, events: 2 });
    const local = await appFor(db);

    const r = await local.inject({ method: "GET", url: "/api/sources" });
    expect(r.statusCode).toBe(200);
    const src = r.json().find((s: { id: string }) => s.id === "isf");
    expect(src.session_count).toBe(1); // 1 main, not 4 (3 subagents excluded)
    await local.close();
  });

  it("GET /api/sources → a source with no sessions still lists, at zero", async () => {
    const db = freshDb({ source: "isf" });
    addSource(db, "empty");
    addSession(db, "m1", { source: "isf" });
    const local = await appFor(db);

    const rows = (await local.inject({ method: "GET", url: "/api/sources" })).json();
    expect(rows.find((s: { id: string }) => s.id === "empty").session_count).toBe(0);
    await local.close();
  });
});

// Schema-version drift: /api/health flags a DB stamped by an older build so the UI can warn that a full
// re-ingest is required (an incremental ingest can't migrate a schema bump).
describe("health surfaces schema staleness", () => {
  it("GET /api/health → schema_stale true when meta.schema_version mismatches the build", async () => {
    const db = freshDb();
    db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '1')").run(); // ancient stamp
    const local = await appFor(db);

    const body = (await local.inject({ method: "GET", url: "/api/health" })).json();
    expect(body.schema_version).toBe(1);
    expect(body.schema_stale).toBe(true);
    await local.close();
  });
});
