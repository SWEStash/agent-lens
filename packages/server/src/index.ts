#!/usr/bin/env node
/**
 * Agent Lens — Stage 3 local server (ADR-005: 127.0.0.1 only, no egress).
 *
 * Read-only REST over the SQLite store + Markdown export, and serves the built web SPA.
 * Usage: agent-lens-server   (env: AGENT_LENS_DB, AGENT_LENS_PORT, AGENT_LENS_HOST)
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { sessionToMarkdown, type MarkdownEvent } from "@agent-lens/core";
import { openReadonly, listSources, listProjects, listModels, listSessions, getSession } from "./db.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dbPath = process.env.AGENT_LENS_DB || join(process.env.AGENT_LENS_DATA || join(repoRoot, "data"), "agent-lens.db");
const host = process.env.AGENT_LENS_HOST || "127.0.0.1"; // loopback only by default
const port = Number(process.env.AGENT_LENS_PORT || 4477);
const webDist = join(repoRoot, "packages/web/dist");

if (host !== "127.0.0.1" && host !== "localhost" && !process.env.AGENT_LENS_ALLOW_NONLOCAL) {
  console.error(
    `agent-lens-server: refusing to bind non-loopback host '${host}' (privacy). ` +
      `Set AGENT_LENS_ALLOW_NONLOCAL=1 to override.`,
  );
  process.exit(1);
}
if (!existsSync(dbPath)) {
  console.error(`agent-lens-server: db not found: ${dbPath} (run ingest first)`);
  process.exit(1);
}

const db = openReadonly(dbPath);
const app = Fastify({ logger: false });

app.get("/api/health", async () => ({ ok: true }));
app.get("/api/sources", async () => listSources(db));
app.get("/api/projects", async () => listProjects(db));
app.get("/api/models", async () => listModels(db));

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
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
    return reply.sendFile("index.html");
  });
} else {
  app.log?.warn?.(`web build not found at ${webDist}; serving API only`);
}

app
  .listen({ host, port })
  .then(() => {
    console.log(`agent-lens-server: http://${host}:${port}  (db: ${dbPath})`);
    if (!existsSync(webDist)) console.log("  note: web SPA not built — run `pnpm --filter @agent-lens/web build`");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
