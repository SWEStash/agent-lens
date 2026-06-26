#!/usr/bin/env node
/**
 * Agent Lens — Stage 2 ingest (ADR-001, ADR-003).
 *
 * Reads the raw archive (mirror + .versions divergence backups), deduplicates events by `uuid`,
 * and (re)builds the normalized SQLite store. Idempotent: unchanged files are skipped via
 * ingest_state; events are inserted with ON CONFLICT DO NOTHING so re-runs add nothing.
 *
 * Usage: agent-lens-ingest [--full] [--db <path>] [--archive <path>]
 *   --full   ignore ingest_state and re-read every file
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { costForUsage, type SourceAdapter, type TurnRow } from "@agent-lens/core";
import { openDb, type DB } from "./db.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface Source {
  label: string;
  agent: string;
  configDir: string;
}

/** Resolve configured sources via the canonical resolver (shared with collect.sh). */
function loadSources(): Source[] {
  const tsv = execFileSync("node", [join(repoRoot, "scripts/sources.mjs")], { encoding: "utf8" });
  const out: Source[] = [];
  for (const line of tsv.split("\n")) {
    if (!line.trim()) continue;
    const [label, agent, configDir] = line.split("\t");
    out.push({ label: label!, agent: agent!, configDir: configDir! });
  }
  return out;
}

function parseArgs(argv: string[]) {
  const a = { full: false, db: "", archive: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--full") a.full = true;
    else if (argv[i] === "--db") a.db = argv[++i] ?? "";
    else if (argv[i] === "--archive") a.archive = argv[++i] ?? "";
  }
  return a;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function preview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 140);
}

function durationMs(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, b - a);
}

/** Group a session's events into turns and return the turns + a uuid→turn_id map. */
function buildTurns(
  sessionId: string,
  rows: Array<{ uuid: string; type: string; is_sidechain: number; is_meta: number; timestamp: string | null; model: string | null; text: string | null }>,
): { turns: TurnRow[]; eventTurn: Map<string, string> } {
  rows.sort((x, y) => (x.timestamp ?? "").localeCompare(y.timestamp ?? "") || x.uuid.localeCompare(y.uuid));
  const turns: TurnRow[] = [];
  const eventTurn = new Map<string, string>();
  let cur: TurnRow | null = null;
  let seq = 0;

  for (const e of rows) {
    // A turn starts at a user prompt with real text. Sidechain (subagent) sessions are entirely
    // sidechain — verified no file mixes main+sidechain events — so their task prompt starts a turn
    // too; we don't filter on is_sidechain here. Tool-result carrier messages have empty text.
    const isPrompt = e.type === "user" && e.is_meta === 0 && !!e.text && e.text.trim().length > 0;
    if (isPrompt) {
      cur = {
        id: `${sessionId}:${seq}`,
        session_id: sessionId,
        seq,
        user_event_uuid: e.uuid,
        prompt_preview: preview(e.text!),
        model: null,
        started_at: e.timestamp,
        ended_at: e.timestamp,
        duration_ms: null,
      };
      turns.push(cur);
      seq++;
    }
    if (cur) {
      eventTurn.set(e.uuid, cur.id);
      if (e.model) cur.model = e.model;
      if (e.timestamp && (!cur.ended_at || e.timestamp > cur.ended_at)) cur.ended_at = e.timestamp;
    }
  }
  for (const t of turns) t.duration_ms = durationMs(t.started_at, t.ended_at);
  return { turns, eventTurn };
}

/** Wipe all ingested data so a changed parser fully re-derives (archive is the source of truth). */
function clearAll(db: DB) {
  db.exec(`
    DELETE FROM token_usage;
    DELETE FROM tool_calls;
    DELETE FROM events;
    DELETE FROM turns;
    DELETE FROM classifications;
    DELETE FROM sessions;
    DELETE FROM sources;
    DELETE FROM projects;
    DELETE FROM ingest_state;
  `);
}

function rebuildDerived(db: DB) {
  // Recompute turns from the (idempotent) events table.
  // Null referencing turn_ids BEFORE deleting turns (FK: events/token_usage/tool_calls -> turns).
  db.exec("UPDATE events SET turn_id = NULL");
  db.exec("UPDATE token_usage SET turn_id = NULL");
  db.exec("UPDATE tool_calls SET turn_id = NULL");
  db.exec("DELETE FROM turns");

  const sessionIds = db.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>;
  const selEvents = db.prepare(
    "SELECT uuid, type, is_sidechain, is_meta, timestamp, model, text FROM events WHERE session_id = ?",
  );
  const insTurn = db.prepare(
    `INSERT INTO turns (id, session_id, seq, user_event_uuid, prompt_preview, model, started_at, ended_at, duration_ms)
     VALUES (@id, @session_id, @seq, @user_event_uuid, @prompt_preview, @model, @started_at, @ended_at, @duration_ms)`,
  );
  const updEventTurn = db.prepare("UPDATE events SET turn_id = ? WHERE uuid = ?");

  const tx = db.transaction(() => {
    for (const { id } of sessionIds) {
      const rows = selEvents.all(id) as any[];
      const { turns, eventTurn } = buildTurns(id, rows);
      for (const t of turns) insTurn.run(t);
      for (const [uuid, turnId] of eventTurn) updEventTurn.run(turnId, uuid);
    }
  });
  tx();

  // Propagate turn_id to dependent tables.
  db.exec("UPDATE token_usage SET turn_id = (SELECT turn_id FROM events WHERE events.uuid = token_usage.event_uuid)");
  db.exec("UPDATE tool_calls SET turn_id = (SELECT turn_id FROM events WHERE events.uuid = tool_calls.event_uuid)");

  // Recompute session aggregates from events/turns.
  db.exec(`
    UPDATE sessions SET
      event_count = (SELECT COUNT(*) FROM events e WHERE e.session_id = sessions.id),
      started_at  = (SELECT MIN(timestamp) FROM events e WHERE e.session_id = sessions.id),
      ended_at    = (SELECT MAX(timestamp) FROM events e WHERE e.session_id = sessions.id),
      turn_count  = (SELECT COUNT(*) FROM turns t WHERE t.session_id = sessions.id),
      is_sidechain = (SELECT CASE WHEN MIN(is_sidechain) = 1 THEN 1 ELSE 0 END FROM events e WHERE e.session_id = sessions.id)
  `);
  db.exec(`
    UPDATE sessions SET duration_ms =
      CAST((julianday(ended_at) - julianday(started_at)) * 86400000 AS INTEGER)
    WHERE started_at IS NOT NULL AND ended_at IS NOT NULL
  `);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = process.env.AGENT_LENS_DATA || join(repoRoot, "data");
  const archiveRoot = args.archive || process.env.AGENT_LENS_ARCHIVE || join(dataDir, "archive");
  const dbPath = args.db || process.env.AGENT_LENS_DB || join(dataDir, "agent-lens.db");

  if (!existsSync(archiveRoot)) {
    console.error(`agent-lens-ingest: archive not found: ${archiveRoot} (run scripts/collect.sh first)`);
    process.exit(1);
  }
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = openDb(dbPath);
  if (args.full) clearAll(db);

  // Adapter registry keyed by agent type; configured sources resolved by the shared resolver.
  const adapterList: SourceAdapter[] = [new ClaudeCodeAdapter()];
  const adapterById = new Map(adapterList.map((a) => [a.agentId, a]));
  const sources = loadSources();
  const now = new Date().toISOString();

  const insAgent = db.prepare("INSERT OR IGNORE INTO agents (id, name, kind) VALUES (?, ?, 'cli')");
  const insSource = db.prepare(
    `INSERT INTO sources (id, label, agent_id, config_dir) VALUES (@id, @label, @agent_id, @config_dir)
     ON CONFLICT(id) DO UPDATE SET label=excluded.label, agent_id=excluded.agent_id, config_dir=excluded.config_dir`,
  );
  const getState = db.prepare("SELECT sha256 FROM ingest_state WHERE file_path = ?") as any;
  const setState = db.prepare(
    `INSERT INTO ingest_state (file_path, size, mtime_ms, sha256, events_ingested, ingested_at)
     VALUES (@file_path, @size, @mtime_ms, @sha256, @events_ingested, @ingested_at)
     ON CONFLICT(file_path) DO UPDATE SET
       size=excluded.size, mtime_ms=excluded.mtime_ms, sha256=excluded.sha256,
       events_ingested=excluded.events_ingested, ingested_at=excluded.ingested_at`,
  );
  const insEvent = db.prepare(
    `INSERT INTO events (uuid, session_id, turn_id, parent_uuid, seq, type, role, timestamp, model, is_sidechain, is_meta, text, raw_json, source_file)
     VALUES (@uuid, @session_id, @turn_id, @parent_uuid, @seq, @type, @role, @timestamp, @model, @is_sidechain, @is_meta, @text, @raw_json, @source_file)
     ON CONFLICT(uuid) DO NOTHING`,
  );
  const insTokens = db.prepare(
    `INSERT INTO token_usage (event_uuid, session_id, turn_id, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, service_tier)
     VALUES (@event_uuid, @session_id, @turn_id, @model, @input_tokens, @output_tokens, @cache_creation_input_tokens, @cache_read_input_tokens, @service_tier)
     ON CONFLICT(event_uuid) DO NOTHING`,
  );
  const insTool = db.prepare(
    `INSERT INTO tool_calls (id, event_uuid, session_id, turn_id, tool_name, caller, skill_name, agent_type, resolved_model, status, total_duration_ms, total_tokens, total_tool_use_count, input_json, result_summary)
     VALUES (@id, @event_uuid, @session_id, @turn_id, @tool_name, @caller, @skill_name, @agent_type, @resolved_model, @status, @total_duration_ms, @total_tokens, @total_tool_use_count, @input_json, @result_summary)
     ON CONFLICT(id) DO NOTHING`,
  );
  const patchTool = db.prepare(
    `UPDATE tool_calls SET
       status = COALESCE(@status, status),
       agent_type = COALESCE(@agent_type, agent_type),
       resolved_model = COALESCE(@resolved_model, resolved_model),
       total_duration_ms = COALESCE(@total_duration_ms, total_duration_ms),
       total_tokens = COALESCE(@total_tokens, total_tokens),
       total_tool_use_count = COALESCE(@total_tool_use_count, total_tool_use_count),
       result_summary = COALESCE(@result_summary, result_summary)
     WHERE id = @tool_use_id`,
  );
  const upsertProject = db.prepare(
    `INSERT INTO projects (id, agent_id, path, encoded_dir, first_seen, last_seen)
     VALUES (@id, @agent_id, @path, @encoded_dir, @now, @now)
     ON CONFLICT(id) DO UPDATE SET last_seen = @now, encoded_dir = COALESCE(excluded.encoded_dir, encoded_dir)`,
  );
  const insSessionStub = db.prepare("INSERT OR IGNORE INTO sessions (id, agent_id, source_id) VALUES (?, ?, ?)");
  const upsertSession = db.prepare(
    `INSERT INTO sessions (id, agent_id, source_id, project_id, slug, ai_title, cli_version, entrypoint, git_branch)
     VALUES (@id, @agent_id, @source_id, @project_id, @slug, @ai_title, @cli_version, @entrypoint, @git_branch)
     ON CONFLICT(id) DO UPDATE SET
       source_id = COALESCE(excluded.source_id, source_id),
       project_id = COALESCE(excluded.project_id, project_id),
       slug = COALESCE(excluded.slug, slug),
       ai_title = COALESCE(excluded.ai_title, ai_title),
       cli_version = COALESCE(excluded.cli_version, cli_version),
       entrypoint = COALESCE(excluded.entrypoint, entrypoint),
       git_branch = COALESCE(excluded.git_branch, git_branch)`,
  );

  const stats = { files: 0, skipped: 0, malformed: 0, newEvents: 0 };

  for (const source of sources) {
    const adapter = adapterById.get(source.agent);
    if (!adapter) {
      console.warn(`agent-lens-ingest: no adapter for agent '${source.agent}' (source '${source.label}') — skipping`);
      continue;
    }
    insAgent.run(adapter.agentId, adapter.agentName);
    insSource.run({ id: source.label, label: source.label, agent_id: adapter.agentId, config_dir: source.configDir });

    const files = adapter.discover(join(archiveRoot, source.label), source.label);
    // Mirror before versions so the mirror copy wins canonical fields (ON CONFLICT DO NOTHING).
    files.sort((a, b) => Number(a.isVersion) - Number(b.isVersion));

    for (const file of files) {
      stats.files++;
      const st = statSync(file.path);
      const buf = readFileSync(file.path);
      const hash = sha256(buf);
      if (!args.full) {
        const prev = getState.get(file.path) as { sha256: string } | undefined;
        if (prev && prev.sha256 === hash) {
          stats.skipped++;
          continue;
        }
      }

      const sessionMeta: Record<string, any> = {};
      let eventsInFile = 0;
      const lines = buf.toString("utf8").split("\n");

      const tx = db.transaction(() => {
        // Ensure the session row exists before any event references it (FK).
        insSessionStub.run(file.sessionId, adapter.agentId, file.sourceId);
        let seq = 0;
        for (const line of lines) {
          if (!line.trim()) continue;
          let raw: unknown;
          try {
            raw = JSON.parse(line);
          } catch {
            stats.malformed++;
            continue;
          }
          const parsed = adapter.parseLine(raw, file, seq++);
          if (parsed.meta) Object.assign(sessionMeta, parsed.meta);
          if (parsed.event) {
            const info = insEvent.run(parsed.event);
            if (info.changes > 0) {
              stats.newEvents++;
              eventsInFile++;
            }
          }
          if (parsed.tokenUsage) insTokens.run(parsed.tokenUsage);
          if (parsed.toolCalls) for (const tc of parsed.toolCalls) insTool.run(tc);
          if (parsed.toolResults)
            for (const tr of parsed.toolResults)
              patchTool.run({
                tool_use_id: tr.tool_use_id,
                status: tr.status ?? null,
                agent_type: tr.agent_type ?? null,
                resolved_model: tr.resolved_model ?? null,
                total_duration_ms: tr.total_duration_ms ?? null,
                total_tokens: tr.total_tokens ?? null,
                total_tool_use_count: tr.total_tool_use_count ?? null,
                result_summary: tr.result_summary ?? null,
              });
        }

        // Persist session + project metadata (survives later skip runs).
        let projectId: string | null = null;
        if (sessionMeta.cwd) {
          projectId = createHash("sha1").update(`${adapter.agentId}\0${sessionMeta.cwd}`).digest("hex").slice(0, 16);
          upsertProject.run({
            id: projectId,
            agent_id: adapter.agentId,
            path: sessionMeta.cwd,
            encoded_dir: file.encodedDir || null,
            now,
          });
        }
        upsertSession.run({
          id: file.sessionId,
          agent_id: adapter.agentId,
          source_id: file.sourceId,
          project_id: projectId,
          slug: sessionMeta.slug ?? null,
          ai_title: sessionMeta.ai_title ?? null,
          cli_version: sessionMeta.cli_version ?? null,
          entrypoint: sessionMeta.entrypoint ?? null,
          git_branch: sessionMeta.git_branch ?? null,
        });

        setState.run({
          file_path: file.path,
          size: st.size,
          mtime_ms: Math.trunc(st.mtimeMs),
          sha256: hash,
          events_ingested: eventsInFile,
          ingested_at: now,
        });
      });
      tx();
    }

  }

  rebuildDerived(db);

  // Report.
  const count = (sql: string) => (db.prepare(sql).get() as any).n as number;
  const sessions = count("SELECT COUNT(*) n FROM sessions");
  const turns = count("SELECT COUNT(*) n FROM turns");
  const events = count("SELECT COUNT(*) n FROM events");
  const tools = count("SELECT COUNT(*) n FROM tool_calls");
  const usageRows = db
    .prepare("SELECT model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens FROM token_usage")
    .all() as any[];
  let cost = 0;
  let totalTokens = 0;
  for (const u of usageRows) {
    cost += costForUsage(u.model, u);
    totalTokens += u.input_tokens + u.output_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
  }

  db.close();
  console.log(
    `agent-lens-ingest: files=${stats.files} skipped=${stats.skipped} new_events=${stats.newEvents} malformed=${stats.malformed}\n` +
      `  sessions=${sessions} turns=${turns} events=${events} tool_calls=${tools}\n` +
      `  tokens=${totalTokens.toLocaleString()} est_cost=$${cost.toFixed(2)} db=${dbPath}`,
  );
}

main();
