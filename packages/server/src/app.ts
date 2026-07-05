/**
 * Agent Lens — Fastify app factory (ADR-005: read-only over the SQLite store).
 *
 * `createApp(db, opts)` builds the route tree against an already-open DB handle so the same app can
 * be driven by the CLI entry (index.ts, with .listen) and by tests (app.inject, no socket).
 */
import { existsSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { sessionToMarkdown, type MarkdownEvent } from "@agent-lens/core";
import { type DB, lastIngested, schemaStatus, listSources, listProjects, listModels, listSessions, getSession, getWorkflow, listSkills, getSkill } from "./db.js";
import { dashboardOverview, dashboardTimeseries, dashboardBreakdowns, type DashFilters } from "./dashboard.js";
import { originAllowed, runRefresh } from "./refresh.js";

export interface CreateAppOpts {
  /** Absolute path to the built web SPA; when present it is served with a history fallback. */
  webDist?: string | null;
}

export async function createApp(db: DB, opts: CreateAppOpts = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.get("/api/health", async () => {
    const s = schemaStatus(db);
    return { ok: true, last_ingested: lastIngested(db), schema_version: s.db_version, schema_stale: s.stale };
  });

  // The one write-action on this read-only server: run a collect + ingest pass on the host so the UI
  // can pull in new transcripts on demand (ADR-015). Guarded against cross-site CSRF (Origin) and
  // concurrent runs (single-instance lock → 409). See refresh.ts.
  app.post("/api/refresh", async (req, reply) => {
    if (!originAllowed(req.headers.origin)) {
      return reply.code(403).send({ error: { code: "FORBIDDEN_ORIGIN", message: "cross-origin refresh blocked" } });
    }
    let result;
    try {
      result = runRefresh();
    } catch (e: any) {
      return reply.code(500).send({ error: { code: "REFRESH_FAILED", message: String(e?.message ?? e) } });
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
      sort: (["started", "title", "turns", "tokens", "cost", "duration"] as const).find((s) => s === q.sort),
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
    const result = getSession(db, id);
    if (!result) return reply.code(404).send({ error: "not found" });
    const s = result.session;
    const events: MarkdownEvent[] = result.events.map((e) => ({
      type: e.type,
      role: e.role,
      timestamp: e.timestamp,
      text: e.text,
      thinking: e.thinking,
      toolCalls: e.toolCalls.map((t: any) => ({
        tool_name: t.tool_name,
        skill_name: t.skill_name,
        agent_type: t.agent_type,
        input_json: t.input_json,
        status: t.status,
      })),
    }));
    const md = sessionToMarkdown(
      {
        id: s.id,
        title: s.title,
        source: s.source_id,
        project: s.project_path,
        model: null,
        started_at: s.started_at,
        ended_at: s.ended_at,
      },
      events,
    );
    reply
      .header("content-type", "text/markdown; charset=utf-8")
      .header("content-disposition", `attachment; filename="session-${id.slice(0, 8)}.md"`)
      .send(md);
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
