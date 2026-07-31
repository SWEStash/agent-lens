/**
 * The runtime half of ADR-026.
 *
 * `@agent-lens/contracts` makes server and web agree at COMPILE time, but `queryAll<T>` is still an
 * unchecked cast — better-sqlite3 has no static knowledge of a query's columns, so a `SELECT` that
 * stops emitting a column, or starts emitting an extra one, type-checks perfectly and drifts anyway.
 * That is the exact gap these tests close: they assert each endpoint's payload has EXACTLY the keys
 * the contract declares, so drift in either direction fails here instead of in the browser.
 *
 * Both directions matter. A *missing* key is a field the UI reads as undefined. An *extra* key is
 * payload nobody declared — harmless on the wire, which is precisely why it accumulated unnoticed
 * until ADR-026 went looking (six such fields were found).
 *
 * Written against exact key sets rather than `toMatchObject` on purpose: a subset assertion is what
 * let the drift happen in the first place.
 */
import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import { addSession, appFor, freshDb, seedBasic } from "./helpers/seed";

/** Exact-key assertion. Sorted so the failure message reads as a set diff, not an ordering complaint. */
function expectKeys(actual: unknown, expected: string[], what: string) {
  expect(Object.keys(actual as object).sort(), `${what}: response keys drifted from the contract`).toEqual(
    [...expected].sort(),
  );
}

// ---- The contract, restated as runtime key sets -------------------------
// Keep these in step with packages/contracts/src/api.ts. Every list below is EXACT: a response
// carrying an extra key fails just as loudly as one missing a key, which is what stops payload
// nobody declared from accumulating again.

const SOURCE_KEYS = ["id", "label", "session_count"];
const PROJECT_KEYS = ["id", "path", "session_count"];

// `title` is derived (ai_title || slug); the raw columns behind it are deliberately not shipped.
const SESSION_SUMMARY_KEYS = [
  "id", "source_id", "is_sidechain", "started_at", "duration_ms",
  "event_count", "turn_count", "project_path", "models", "tokens", "token_split", "cost", "title",
  "tool_call_count", "tool_error_count", "finding_count", "worst_severity",
];

const SESSION_DETAIL_KEYS = [
  "session", "turns", "events", "classification", "parent", "children", "workflow_runs", "findings",
  "file_changes",
];

const EVENT_NODE_KEYS = ["uuid", "type", "role", "timestamp", "model", "is_sidechain", "turn_id", "text", "thinking", "toolCalls"];

// No event_uuid (the server already used it to nest this call), no error_type (server-side split
// only), no total_tokens (nothing reads it) — see ToolCallProjection in server/src/rows.ts.
const TOOL_CALL_KEYS = [
  "id", "tool_name", "skill_name", "skill_id", "agent_type", "spawned_session_id",
  "workflow_run_id", "workflow_name", "status", "total_duration_ms",
  "input_json", "result_summary", "workflow_agent_count", "findings",
];

const TOKEN_SPLIT_KEYS = ["input", "output", "cache_creation", "cache_read"];

const DASH_OVERVIEW_KEYS = [
  "range", "sessions", "sessions_main", "sessions_subagent", "turns", "projects", "tool_calls",
  "tokens", "total_tokens", "cache_read_ratio", "cost", "unpriced_models", "turn_duration_ms",
  "session_duration_ms", "workflows",
];

const DASH_BREAKDOWN_KEYS = [
  "by_model", "by_source", "by_category", "by_complexity", "tools", "skills", "skill_versions",
  "subagent_fanout", "error_types",
];

const SECURITY_SUMMARY_KEYS = [
  "total", "sessions_flagged", "dismissed", "muted", "by_severity", "by_category", "by_rule", "categories",
];

const HEALTH_KEYS = ["ok", "last_ingested", "schema_version", "schema_stale", "version", "version_source"];

// /api/about (ADR-027). Nested groups are asserted separately below — the exact-key rule applies at
// every level, since that is where an undeclared path or metric would slip in.
const ABOUT_KEYS = ["versions", "paths", "server", "retention", "sources", "storage"];
const ABOUT_VERSIONS_KEYS = ["app", "app_source", "schema", "schema_expected", "schema_stale", "detector", "classifier"];
const ENGINE_VERSION_KEYS = ["expected", "in_data", "stale"];
const ABOUT_RETENTION_KEYS = ["versions_keep_days", "origin"];
const ABOUT_PATHS_KEYS = ["config_file", "data_dir", "archive", "db", "triage_db"];
const ABOUT_SERVER_KEYS = ["host", "port", "loopback_only"];
const ABOUT_STORAGE_KEYS = ["db_bytes", "archive_bytes", "archive_files", "last_ingested"];
const PATH_INFO_KEYS = ["path", "origin"];

describe("response contracts — populated DB", () => {
  it("GET /api/health matches HealthResponse", async () => {
    const app = await appFor(seedBasic());
    expectKeys((await app.inject({ method: "GET", url: "/api/health" })).json(), HEALTH_KEYS, "health");
    await app.close();
  });

  it("GET /api/about matches AboutResponse, at every level", async () => {
    const app = await appFor(seedBasic(), {
      about: {
        db: { path: "/tmp/x/agent-lens.db", origin: "default" },
        host: "127.0.0.1",
        port: 4477,
        loopbackOnly: true,
        repoRoot: null,
      },
    });
    const body = (await app.inject({ method: "GET", url: "/api/about" })).json();
    expectKeys(body, ABOUT_KEYS, "about");
    expectKeys(body.versions, ABOUT_VERSIONS_KEYS, "about.versions");
    expectKeys(body.paths, ABOUT_PATHS_KEYS, "about.paths");
    expectKeys(body.server, ABOUT_SERVER_KEYS, "about.server");
    expectKeys(body.storage, ABOUT_STORAGE_KEYS, "about.storage");
    expectKeys(body.retention, ABOUT_RETENTION_KEYS, "about.retention");
    expectKeys(body.versions.detector, ENGINE_VERSION_KEYS, "about.versions.detector");
    expectKeys(body.versions.classifier, ENGINE_VERSION_KEYS, "about.versions.classifier");
    // Every path except config_file (a bare string|null) is a PathInfo carrying its provenance.
    for (const k of ["data_dir", "archive", "db", "triage_db"]) {
      expectKeys(body.paths[k], PATH_INFO_KEYS, `about.paths.${k}`);
    }
    await app.close();
  });

  it("GET /api/sources matches Source[]", async () => {
    const app = await appFor(seedBasic());
    const body = (await app.inject({ method: "GET", url: "/api/sources" })).json();
    expect(body).toHaveLength(1);
    expectKeys(body[0], SOURCE_KEYS, "source row");
    await app.close();
  });

  it("GET /api/projects matches Project[]", async () => {
    const app = await appFor(seedBasic());
    const body = (await app.inject({ method: "GET", url: "/api/projects" })).json();
    expectKeys(body[0], PROJECT_KEYS, "project row");
    await app.close();
  });

  it("GET /api/models is a flat string[], not row objects", async () => {
    const app = await appFor(seedBasic());
    const body = (await app.inject({ method: "GET", url: "/api/models" })).json();
    expect(body).toEqual(["claude-opus-4-8"]);
    await app.close();
  });

  it("GET /api/sessions matches SessionsPage / SessionSummary", async () => {
    const app = await appFor(seedBasic());
    const body = (await app.inject({ method: "GET", url: "/api/sessions" })).json();
    expectKeys(body, ["total", "sessions"], "sessions page");
    expectKeys(body.sessions[0], SESSION_SUMMARY_KEYS, "session summary");
    expectKeys(body.sessions[0].token_split, TOKEN_SPLIT_KEYS, "token_split");
    await app.close();
  });

  it("the JS-sorted page returns the same SessionSummary shape as the SQL-sorted one", async () => {
    // tokens/cost/errors/security sort in JS over the whole matching set, a separate code path from
    // the SQL ORDER BY page — so it gets its own shape assertion.
    const app = await appFor(seedBasic());
    const body = (await app.inject({ method: "GET", url: "/api/sessions?sort=tokens" })).json();
    expectKeys(body.sessions[0], SESSION_SUMMARY_KEYS, "session summary (JS sort path)");
    await app.close();
  });

  it("GET /api/sessions/:id matches SessionDetail, down to the nested event + tool call", async () => {
    const app = await appFor(seedBasic());
    const body = (await app.inject({ method: "GET", url: "/api/sessions/sess1" })).json();
    expectKeys(body, SESSION_DETAIL_KEYS, "session detail");

    // SessionDetailData extends SessionRow (the endpoint does SELECT s.*), so assert the added
    // fields rather than restating the whole DDL — that part is the row contract's job.
    for (const k of ["project_path", "tokens", "token_split", "cost", "title", "tool_call_count", "tool_error_count", "tool_rejection_count", "tool_failure_count"]) {
      expect(body.session, `session detail is missing ${k}`).toHaveProperty(k);
    }

    expectKeys(body.events[0], EVENT_NODE_KEYS, "event node");
    const withTool = body.events.find((e: { toolCalls: unknown[] }) => e.toolCalls.length > 0);
    expectKeys(withTool.toolCalls[0], TOOL_CALL_KEYS, "tool call");
    await app.close();
  });

  it("an inline session finding omits session_id; a /security list row carries it", async () => {
    // The mismatch ADR-026 turned up: Finding.session_id was declared required and the inline
    // projection never emitted it. FindingListRow is the narrowed list type. Pin both sides.
    const db = seedBasic();
    addFinding(db, "f1", "sess1", "tc1");
    const app = await appFor(db);

    const detail = (await app.inject({ method: "GET", url: "/api/sessions/sess1" })).json();
    expect(detail.findings).toHaveLength(1);
    expect(detail.findings[0]).not.toHaveProperty("session_id");
    expectKeys(
      detail.findings[0],
      ["id", "tool_call_id", "event_uuid", "turn_id", "rule_id", "category", "framework_ref", "severity", "title", "evidence", "signals"],
      "inline finding",
    );

    const list = (await app.inject({ method: "GET", url: "/api/security/findings" })).json();
    expectKeys(list, ["total", "findings"], "findings page");
    expect(list.findings[0].session_id).toBe("sess1");
    await app.close();
  });

  it("GET /api/security/summary matches SecuritySummary", async () => {
    const app = await appFor(seedBasic());
    expectKeys(
      (await app.inject({ method: "GET", url: "/api/security/summary" })).json(),
      SECURITY_SUMMARY_KEYS,
      "security summary",
    );
    await app.close();
  });

  it("GET /api/dashboard/* match DashOverview / DashTimeseries / DashBreakdowns", async () => {
    const app = await appFor(seedBasic());

    const overview = (await app.inject({ method: "GET", url: "/api/dashboard/overview" })).json();
    expectKeys(overview, DASH_OVERVIEW_KEYS, "dash overview");
    expectKeys(overview.tokens, TOKEN_SPLIT_KEYS, "dash overview tokens");
    expectKeys(overview.range, ["from", "to", "source"], "dash overview range");
    expectKeys(overview.turn_duration_ms, ["p50", "p95", "count"], "turn_duration_ms");
    expectKeys(overview.session_duration_ms, ["p50", "p95", "count"], "session_duration_ms");
    expectKeys(
      overview.workflows,
      ["total", "by_status", "completed", "failed", "success_rate", "total_tokens", "avg_duration_ms"],
      "workflows rollup",
    );

    const ts = (await app.inject({ method: "GET", url: "/api/dashboard/timeseries" })).json();
    expectKeys(ts, ["bucket", "series"], "dash timeseries");
    expectKeys(
      ts.series[0],
      [...TOKEN_SPLIT_KEYS, "bucket", "cost", "sessions", "turns", "failures", "rejections"],
      "timeseries point",
    );

    const bd = (await app.inject({ method: "GET", url: "/api/dashboard/breakdowns" })).json();
    expectKeys(bd, DASH_BREAKDOWN_KEYS, "dash breakdowns");
    expectKeys(bd.by_model[0], ["model", "tokens", "total_tokens", "cost", "sessions", "priced"], "by_model row");
    expectKeys(
      bd.subagent_fanout,
      ["by_type", "sessions_with_subagents", "total_spawns", "max_per_session", "avg_per_session"],
      "subagent_fanout",
    );
    expectKeys(bd.error_types, ["by_type", "failures", "rejections"], "error_types");
    await app.close();
  });

  it("GET /api/skills and /api/skills/:name match SkillSummary / SkillDetail", async () => {
    const app = await appFor(seedBasic());

    const list = (await app.inject({ method: "GET", url: "/api/skills" })).json();
    expectKeys(list[0], ["name", "call_count", "version_count", "last_fired", "sources"], "skill summary");
    expect(Array.isArray(list[0].sources), "sources must be split into an array, not left a GROUP_CONCAT string").toBe(true);

    const detail = (await app.inject({ method: "GET", url: "/api/skills/test-suite-design" })).json();
    expectKeys(detail, ["name", "versions", "sessions", "call_count"], "skill detail");
    expectKeys(
      detail.sessions[0],
      ["id", "source_id", "started_at", "project_path", "version_id", "fired_at", "fire_count", "title"],
      "skill session",
    );
    await app.close();
  });
});

describe("the wire carries only what the contract declares", () => {
  // These pin the *trim* specifically: each asserts a field is absent, so re-adding it to a SELECT
  // (the way six of them accumulated in the first place) fails here rather than shipping unnoticed.

  it("derives `title` and does not ship the raw title columns", async () => {
    const db = seedBasic();
    addSession(db, "kid", { parent: "sess1", sidechain: true, title: "child", startedAt: "2026-01-01T00:01:00Z" });
    const app = await appFor(db);

    const list = (await app.inject({ method: "GET", url: "/api/sessions" })).json();
    // By id, not by index: the list is unfiltered here and the subagent sorts first by started_at.
    const row = list.sessions.find((s: { id: string }) => s.id === "sess1");
    expect(row.title).toBe("Demo session");
    expect(row).not.toHaveProperty("ai_title");
    expect(row).not.toHaveProperty("slug");

    const detail = (await app.inject({ method: "GET", url: "/api/sessions/sess1" })).json();
    expect(detail.children[0].title).toBe("child");
    expect(detail.children[0]).not.toHaveProperty("ai_title");
    expect(detail.children[0]).not.toHaveProperty("slug");

    // The ONE shape that does carry them, and deliberately: getSession's `SELECT s.*` is the whole
    // row, which is why SessionDetailData extends SessionRow (ADR-026).
    expect(detail.session).toHaveProperty("ai_title");
    expect(detail.session).toHaveProperty("slug");
    await app.close();
  });

  it("a tool call keeps its internal columns off the wire", async () => {
    const db = seedBasic();
    const app = await appFor(db);
    const body = (await app.inject({ method: "GET", url: "/api/sessions/sess1" })).json();
    const call = body.events.find((e: { toolCalls: unknown[] }) => e.toolCalls.length > 0).toolCalls[0];
    for (const k of ["event_uuid", "error_type", "total_tokens"]) {
      expect(call, `tool call should not ship ${k}`).not.toHaveProperty(k);
    }
    await app.close();
  });

  it("still splits failures from rejections after error_type left the payload", async () => {
    // error_type is dropped from the RESPONSE but still read server-side; this is the assertion that
    // stops the trim from quietly breaking the split.
    const db = seedBasic();
    db.prepare("UPDATE tool_calls SET status = 'error', error_type = 'user-rejected' WHERE id = 'tc1'").run();
    const app = await appFor(db);

    const s = (await app.inject({ method: "GET", url: "/api/sessions/sess1" })).json().session;
    expect(s.tool_error_count).toBe(1);
    expect(s.tool_rejection_count).toBe(1);
    expect(s.tool_failure_count).toBe(0);
    await app.close();
  });

  it("labels a null-model token bucket instead of emitting a nameless one", async () => {
    // token_usage.model is nullable and the by_model GROUP BY does not exclude nulls, so the bucket
    // reached the chart with model: null and rendered as an unnamed bar. Now COALESCEd, as by_source
    // already does. Red without the COALESCE.
    const db = freshDb();
    addSession(db, "s1", { startedAt: "2026-01-01T00:00:00Z" });
    addEventlessUsage(db, "s1");
    const app = await appFor(db);

    const bd = (await app.inject({ method: "GET", url: "/api/dashboard/breakdowns" })).json();
    const bucket = bd.by_model.find((m: { model: string }) => m.model === "(unknown)");
    expect(bucket, "a null-model bucket should be labelled, not null").toBeTruthy();
    expect(bd.by_model.every((m: { model: unknown }) => typeof m.model === "string")).toBe(true);
    await app.close();
  });
});

describe("response contracts — degraded DBs keep the shape stable", () => {
  // The server opens the DB read-only, so a not-yet-ingested or older schema must degrade rather
  // than throw — and, per ADR-026, must degrade to the SAME shape with null/0/[] stand-ins. That is
  // why the contract uses `| null` far more than `?`. Each case drops the table the guard checks.

  it("no findings table → the security endpoints keep their shape", async () => {
    const db = seedBasic();
    db.exec("DROP TABLE findings");
    const app = await appFor(db);

    expectKeys(
      (await app.inject({ method: "GET", url: "/api/security/summary" })).json(),
      SECURITY_SUMMARY_KEYS,
      "security summary (no findings table)",
    );
    const list = (await app.inject({ method: "GET", url: "/api/security/findings" })).json();
    expect(list).toEqual({ total: 0, findings: [] });
    await app.close();
  });

  it("no session_meta table → children still carry agent_type/description/spawn_depth as null", async () => {
    const db = seedBasic();
    addSession(db, "kid", { parent: "sess1", sidechain: true, title: "child", startedAt: "2026-01-01T00:01:00Z" });
    db.exec("DROP TABLE session_meta");
    const app = await appFor(db);

    const body = (await app.inject({ method: "GET", url: "/api/sessions/sess1" })).json();
    expect(body.children).toHaveLength(1);
    // Present-and-null, not absent — metaProjection emits `NULL AS ...` precisely so the shape holds.
    for (const k of ["agent_type", "agent_description", "spawn_depth"]) {
      expect(body.children[0], `child is missing ${k}`).toHaveProperty(k);
      expect(body.children[0][k]).toBeNull();
    }
    await app.close();
  });

  it("pre-v14 DB (no file_changes) → file endpoints return empty, not an error", async () => {
    const db = seedBasic();
    db.exec("DROP TABLE file_changes");
    const app = await appFor(db);

    const list = (await app.inject({ method: "GET", url: "/api/files" })).json();
    expect(list).toEqual({ total: 0, files: [] });

    const detail = (await app.inject({ method: "GET", url: "/api/sessions/sess1" })).json();
    expect(detail.file_changes).toEqual([]);

    const timeline = await app.inject({ method: "GET", url: "/api/file?path=/tmp/proj/x.ts" });
    expect(timeline.statusCode).toBe(404);
    await app.close();
  });

  it("no triage store attached → findings still carry the triage keys as 0/null stand-ins", async () => {
    const db = seedBasic();
    addFinding(db, "f1", "sess1", "tc1");
    const app = await appFor(db); // no triageDbPath → nothing ATTACHed

    const row = (await app.inject({ method: "GET", url: "/api/security/findings" })).json().findings[0];
    expect(row.dismissed).toBe(0);
    expect(row.muted).toBe(0);
    expect(row.dismiss_note).toBeNull();
    expect(row.dismissed_at).toBeNull();
    await app.close();
  });

  it("an empty DB returns the same dashboard shape as a populated one", async () => {
    const app = await appFor(freshDb());
    expectKeys((await app.inject({ method: "GET", url: "/api/dashboard/overview" })).json(), DASH_OVERVIEW_KEYS, "dash overview (empty)");
    expectKeys((await app.inject({ method: "GET", url: "/api/dashboard/breakdowns" })).json(), DASH_BREAKDOWN_KEYS, "dash breakdowns (empty)");
    expectKeys((await app.inject({ method: "GET", url: "/api/dashboard/timeseries" })).json(), ["bucket", "series"], "dash timeseries (empty)");
    await app.close();
  });
});

/** Token usage with a NULL model — the case the by_model GROUP BY does not filter out. `addTokens`
 *  requires a model, so this one writes the row directly. */
function addEventlessUsage(db: Database.Database, session: string) {
  db.prepare("INSERT INTO events (uuid, session_id, seq, type, role, timestamp, raw_json) VALUES ('ev0', ?, 0, 'assistant', 'assistant', '2026-01-01T00:00:00Z', '{}')").run(session);
  db.prepare(
    `INSERT INTO token_usage (event_uuid, session_id, model, input_tokens, output_tokens,
                              cache_creation_input_tokens, cache_read_input_tokens)
     VALUES ('ev0', ?, NULL, 10, 5, 0, 0)`,
  ).run(session);
}

/** A findings row (ADR-017). Not in seed.ts because only the security suites need it. */
function addFinding(db: Database.Database, id: string, session: string, toolCall: string) {
  db.prepare(
    `INSERT INTO findings (id, session_id, tool_call_id, rule_id, category, framework_ref, severity, title, evidence, signals_json, detector_version)
     VALUES (?, ?, ?, 'SA01', 'secrets', 'OWASP-A02', 'high', 'Secret in command', 'export TOKEN=...', '{"rule":"SA01"}', 1)`,
  ).run(id, session, toolCall);
}
