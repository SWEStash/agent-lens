/**
 * Agent Lens — Fastify app factory (ADR-005: read-only over the SQLite store).
 *
 * `createApp(db, opts)` builds the route tree against an already-open DB handle so the same app can
 * be driven by the CLI entry (index.ts, with .listen) and by tests (app.inject, no socket).
 */
import { existsSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { renderSessionExport, parseRedactionLevel } from "./export.js";
import { type DB, lastIngested, schemaStatus, listSources, listProjects, listModels, listSessions, getSession, getWorkflow, listSkills, getSkill, listFindings, securitySummary } from "./db.js";
import { dashboardOverview, dashboardTimeseries, dashboardBreakdowns, type DashFilters } from "./dashboard.js";
import { writeBlocked, runRefresh } from "./refresh.js";
import { openTriage, dismiss, reopen, muteRule, unmute, listMutes, type TriageDB, type MuteScope } from "./triage.js";
import { PREFS_SCHEMA_SQL, getPref, setPref } from "./prefs.js";

export interface CreateAppOpts {
  /** Absolute path to the built web SPA; when present it is served with a history fallback. */
  webDist?: string | null;
  /** Path to the writable security-triage store (ADR-018). When set, it is opened read-write for
   *  triage writes and ATTACHed to the read handle so the findings list can JOIN triage state. */
  triageDbPath?: string | null;
  /** Reject any request whose Host authority is not loopback (DNS-rebinding defense, HIGH-001).
   *  Defaults to true; the intentional non-local bind (AGENT_LENS_ALLOW_NONLOCAL) passes false. */
  enforceLoopbackHost?: boolean;
}

/** Loopback host authorities (hostname only; any port). A request Host outside this set is treated
 *  as a DNS-rebinding attempt and rejected before any handler runs. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export async function createApp(db: DB, opts: CreateAppOpts = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // HIGH-001: binding 127.0.0.1 stops direct remote connections but NOT DNS rebinding — a page on
  // evil.com re-resolved to 127.0.0.1 makes same-origin requests the browser will let it read. Reads
  // are unauthenticated, so without a Host check the whole transcript store is exfiltratable. Reject
  // any non-loopback Host up front. This also removes the residual write ambiguity (Origin-absent).
  if (opts.enforceLoopbackHost !== false) {
    app.addHook("onRequest", async (req, reply) => {
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (!LOOPBACK_HOSTS.has(host)) {
        return reply.code(403).send({ error: { code: "FORBIDDEN_HOST", message: "non-loopback Host rejected" } });
      }
    });
  }

  // Baseline security headers on every response (incl. static SPA + errors). Anti-clickjacking
  // (`X-Frame-Options`/`frame-ancestors`) matters here because framing the loopback UI could drive
  // the Origin-passing write routes. A full script/style CSP is deliberately omitted — it risks
  // breaking the SPA and adds little on a loopback-only, Host-guarded server (tracked as follow-up).
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Frame-Options", "DENY");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", "frame-ancestors 'none'");
    return payload;
  });

  // Security triage store (ADR-018): a separate writable SQLite, ATTACHed to the read handle so the
  // findings queries can JOIN dismissed/muted state, while writes go through `triageDb`. The analytics
  // handle stays read-only. Absent → the security endpoints degrade to the un-triaged (all-open) view.
  let triageDb: TriageDB | null = null;
  if (opts.triageDbPath) {
    triageDb = openTriage(opts.triageDbPath); // creates the file + schema before we ATTACH it
    triageDb.exec(PREFS_SCHEMA_SQL); // UI-prefs table rides the same writable sidecar (see prefs.ts)
    db.exec(`ATTACH DATABASE '${opts.triageDbPath.replace(/'/g, "''")}' AS triage`);
    app.addHook("onClose", async () => triageDb?.close());
  }

  // Shared CSRF + availability guard for the triage write routes (same posture as /api/refresh).
  const guardWrite = (req: any, reply: any): boolean => {
    if (writeBlocked(req.headers)) {
      reply.code(403).send({ error: { code: "FORBIDDEN_ORIGIN", message: "cross-origin write blocked" } });
      return false;
    }
    if (!triageDb) {
      reply.code(503).send({ error: { code: "TRIAGE_UNAVAILABLE", message: "triage store not configured" } });
      return false;
    }
    return true;
  };

  app.get("/api/health", async () => {
    const s = schemaStatus(db);
    return { ok: true, last_ingested: lastIngested(db), schema_version: s.db_version, schema_stale: s.stale };
  });

  // The one write-action on this read-only server: run a collect + ingest pass on the host so the UI
  // can pull in new transcripts on demand (ADR-015). Guarded against cross-site CSRF (Origin) and
  // concurrent runs (single-instance lock → 409). See refresh.ts.
  app.post("/api/refresh", async (req, reply) => {
    if (writeBlocked(req.headers)) {
      return reply.code(403).send({ error: { code: "FORBIDDEN_ORIGIN", message: "cross-origin refresh blocked" } });
    }
    let result;
    try {
      result = runRefresh();
    } catch (e: any) {
      // Don't leak the raw exception (may include host filesystem paths, LOW-003) to the client; the
      // recipient is the local user but a generic message keeps this safe if ever exposed. Detail → log.
      console.error("agent-lens-server: refresh failed:", e);
      return reply.code(500).send({ error: { code: "REFRESH_FAILED", message: "refresh failed; see server logs" } });
    }
    if (!result) {
      return reply.code(409).send({ error: { code: "REFRESH_IN_PROGRESS", message: "a collect/ingest run is already in progress" } });
    }
    return { ok: true, collected: result.collected, last_ingested: lastIngested(db) };
  });
  app.get("/api/sources", async () => listSources(db));
  app.get("/api/projects", async () => listProjects(db));
  app.get("/api/models", async () => listModels(db));

  // Dashboard aggregates (Phase 4). All read-only; filters: source, from, to.
  const dashFilters = (req: any): DashFilters => {
    const q = req.query as Record<string, string>;
    return { source: q.source, from: q.from, to: q.to };
  };
  app.get("/api/dashboard/overview", async (req) => dashboardOverview(db, dashFilters(req)));
  app.get("/api/dashboard/timeseries", async (req) => {
    const q = req.query as Record<string, string>;
    return dashboardTimeseries(db, dashFilters(req), q.bucket);
  });
  app.get("/api/dashboard/breakdowns", async (req) => dashboardBreakdowns(db, dashFilters(req)));

  // UI preferences (chart/column visibility, per-chart toggles). Stored in the writable sidecar
  // (prefs.ts); localStorage on the client is an optimistic cache. GET degrades to `{value:null}` when
  // no writable store is configured so the client simply keeps its local value. PUT reuses the same
  // CSRF+availability guard as the other writes.
  const PREF_KEY = /^[a-z0-9._-]{1,64}$/i;
  app.get("/api/prefs/:key", async (req, reply) => {
    const { key } = req.params as { key: string };
    if (!PREF_KEY.test(key)) return reply.code(400).send({ error: { code: "BAD_KEY", message: "invalid pref key" } });
    if (!triageDb) return { value: null };
    const raw = getPref(triageDb, key);
    return { value: raw == null ? null : JSON.parse(raw) };
  });
  app.put("/api/prefs/:key", async (req, reply) => {
    const { key } = req.params as { key: string };
    if (!PREF_KEY.test(key)) return reply.code(400).send({ error: { code: "BAD_KEY", message: "invalid pref key" } });
    if (!guardWrite(req, reply)) return;
    const body = req.body as { value?: unknown };
    setPref(triageDb!, key, JSON.stringify(body?.value ?? null));
    return { ok: true };
  });

  app.get("/api/sessions", async (req) => {
    const q = req.query as Record<string, string>;
    return listSessions(db, {
      source: q.source,
      project: q.project,
      model: q.model,
      q: q.q,
      from: q.from,
      to: q.to,
      kind: q.kind === "main" || q.kind === "subagent" ? q.kind : undefined,
      severity: q.severity ? q.severity.split(",").filter(Boolean) : undefined,
      errorType: q.error_type ? q.error_type.split(",").filter(Boolean) : undefined,
      sort: (["started", "title", "turns", "tokens", "cost", "duration", "errors", "security"] as const).find((s) => s === q.sort),
      dir: q.dir === "asc" ? "asc" : q.dir === "desc" ? "desc" : undefined,
      limit: Math.min(Number(q.limit) || 50, 200),
      offset: Number(q.offset) || 0,
    });
  });

  app.get("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = getSession(db, id);
    if (!result) return reply.code(404).send({ error: "not found" });
    return result;
  });

  app.get("/api/workflows/:run_id", async (req, reply) => {
    const { run_id } = req.params as { run_id: string };
    const result = getWorkflow(db, run_id);
    if (!result) return reply.code(404).send({ error: "not found" });
    return result;
  });

  // Security findings (ADR-017). Read-only; browsable list + roll-up summary for the /security page,
  // the transcript inline badges (served via /api/sessions/:id), and the Dashboard KPI.
  app.get("/api/security/summary", async () => securitySummary(db));
  const findingFilters = (q: Record<string, string>) => ({
    severity: q.severity,
    category: q.category,
    rule: q.rule,
    session: q.session,
    source: q.source,
    project: q.project,
    from: q.from,
    to: q.to,
    status: (["open", "dismissed", "muted", "all"] as const).find((s) => s === q.status),
  });
  app.get("/api/security/findings", async (req) => {
    const q = req.query as Record<string, string>;
    return listFindings(db, {
      ...findingFilters(q),
      sort: (["severity", "session", "rule", "category", "time"] as const).find((s) => s === q.sort),
      dir: q.dir === "asc" ? "asc" : q.dir === "desc" ? "desc" : undefined,
      limit: Math.min(Number(q.limit) || 50, 5000),
      offset: Number(q.offset) || 0,
    });
  });

  // Triage writes (ADR-018): CSRF-guarded, loopback-only, same posture as /api/refresh.
  app.get("/api/security/mutes", async () => (triageDb ? listMutes(triageDb) : []));
  app.post("/api/security/dismiss", async (req, reply) => {
    if (!guardWrite(req, reply)) return reply;
    const b = (req.body ?? {}) as { ids?: string[]; note?: string };
    const n = dismiss(triageDb!, Array.isArray(b.ids) ? b.ids : [], b.note ?? null);
    return { ok: true, dismissed: n };
  });
  app.post("/api/security/reopen", async (req, reply) => {
    if (!guardWrite(req, reply)) return reply;
    const b = (req.body ?? {}) as { ids?: string[] };
    const n = reopen(triageDb!, Array.isArray(b.ids) ? b.ids : []);
    return { ok: true, reopened: n };
  });
  // Dismiss every OPEN finding matching a filter (bulk cleanup) — collects ids server-side, then marks.
  app.post("/api/security/dismiss-matching", async (req, reply) => {
    if (!guardWrite(req, reply)) return reply;
    const b = (req.body ?? {}) as { filter?: Record<string, string>; note?: string };
    const page = listFindings(db, { ...findingFilters(b.filter ?? {}), status: "open", limit: 100000, offset: 0 });
    const ids = (page.findings as Array<{ id: string }>).map((r) => r.id);
    const n = dismiss(triageDb!, ids, b.note ?? null);
    return { ok: true, dismissed: n };
  });
  app.post("/api/security/mute", async (req, reply) => {
    if (!guardWrite(req, reply)) return reply;
    const b = (req.body ?? {}) as { rule_id?: string; scope?: string; scope_id?: string; note?: string };
    if (!b.rule_id) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "rule_id required" } });
    const scope = (["global", "project", "source"] as const).find((s) => s === b.scope) ?? "global";
    muteRule(triageDb!, b.rule_id, scope as MuteScope, b.scope_id ?? "", b.note ?? null);
    return { ok: true };
  });
  app.post("/api/security/unmute", async (req, reply) => {
    if (!guardWrite(req, reply)) return reply;
    const b = (req.body ?? {}) as { rule_id?: string; scope?: string; scope_id?: string };
    if (!b.rule_id) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "rule_id required" } });
    const scope = (["global", "project", "source"] as const).find((s) => s === b.scope) ?? "global";
    const n = unmute(triageDb!, b.rule_id, scope as MuteScope, b.scope_id ?? "");
    return { ok: true, unmuted: n };
  });

  app.get("/api/skills", async (req) => {
    const q = req.query as Record<string, string>;
    return listSkills(db, { q: q.q, source: q.source, project: q.project });
  });

  app.get("/api/skills/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const result = getSkill(db, decodeURIComponent(name));
    if (!result) return reply.code(404).send({ error: "not found" });
    return result;
  });

  app.get("/api/sessions/:id/export.md", async (req, reply) => {
    const { id } = req.params as { id: string };
    // Redaction defaults ON (selective secret/PII masking). `structure` = aggressive scrub;
    // `off` = explicit verbatim opt-out. Anything unrecognized falls back to the safe default.
    const level = parseRedactionLevel((req.query as { redact?: string }).redact);
    const out = renderSessionExport(db, id, level);
    if (!out) return reply.code(404).send({ error: "not found" });
    reply
      .header("content-type", "text/markdown; charset=utf-8")
      .header("content-disposition", `attachment; filename="${out.filename}"`)
      .send(out.markdown);
  });

  // Serve the built SPA (if present) with a history fallback for client routes.
  if (opts.webDist && existsSync(opts.webDist)) {
    await app.register(fastifyStatic, { root: opts.webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}
