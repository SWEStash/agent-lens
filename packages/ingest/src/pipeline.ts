/**
 * Agent Lens — ingest engine (the DB-writing core of Stage 2), separated from the CLI bootstrap in
 * index.ts so it can be driven in-process by tests against an :memory: DB. index.ts handles argv/env,
 * the disk walk, and the incremental-skip check; everything here operates on an open DB + file content.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { packRaw, type SourceAdapter, type SourceFile, type TurnRow } from "@agent-lens/core";
import { type DB } from "./db.js";

type Stmt = Database.Statement<any[]>;

export interface IngestStats {
  files: number;
  skipped: number;
  malformed: number;
  newEvents: number;
}

export function newStats(): IngestStats {
  return { files: 0, skipped: 0, malformed: 0, newEvents: 0 };
}

export function preview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 140);
}

const SKILL_INJECT_PREFIX = "Base directory for this skill:";

/** Final name token of a skill id/dir, ignoring path and plugin prefix: "plugin:foo" / ".../foo" → "foo". */
function skillNameKey(name: string): string {
  const afterSlash = name.split("/").pop() ?? name;
  const afterColon = afterSlash.split(":").pop() ?? afterSlash;
  return afterColon.trim();
}

/**
 * Parse a skill-body injection event. A Skill firing injects an isMeta user message of the shape
 *   `Base directory for this skill: <abs path>/<name>\n\n<SKILL.md body>\n\nARGUMENTS: <args>`
 * into the transcript — the only place the real skill content appears. We split off the
 * Base-directory line (path differs per install) and the trailing ARGUMENTS block (per-call) so the
 * remaining body is stable across installs/args and can be content-hashed into a version.
 */
export function parseSkillInjection(
  text: string,
): { baseDir: string | null; nameKey: string; body: string; args: string | null } | null {
  if (!text.startsWith(SKILL_INJECT_PREFIX)) return null;
  const firstNl = text.indexOf("\n");
  const firstLine = (firstNl >= 0 ? text.slice(0, firstNl) : text).slice(SKILL_INJECT_PREFIX.length).trim();
  const baseDir = firstLine || null;
  let body = firstNl >= 0 ? text.slice(firstNl + 1) : "";
  // Strip the trailing per-call ARGUMENTS block (use lastIndexOf — the body may mention "ARGUMENTS").
  let args: string | null = null;
  const argIdx = body.lastIndexOf("\nARGUMENTS:");
  if (argIdx >= 0) {
    args = body.slice(argIdx + "\nARGUMENTS:".length).trim() || null;
    body = body.slice(0, argIdx);
  }
  return { baseDir, nameKey: baseDir ? skillNameKey(baseDir) : "", body: body.trim(), args };
}

/** First markdown heading (or first non-empty line) of a body, for list/detail display. */
function skillSummary(body: string): string | null {
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    return (t.startsWith("#") ? t.replace(/^#+\s*/, "").trim() : t).slice(0, 200) || null;
  }
  return null;
}

/** Content-addressed skill version id: hash of name + normalized body (matches the project's sha1 id convention). */
function skillVersionId(name: string, body: string): string {
  return createHash("sha1").update(name).update("\0").update(body).digest("hex").slice(0, 16);
}

/**
 * Remove every session whose project path is in `excludedPaths` — plus its subagent descendants —
 * along with all dependent rows (events → FTS via trigger, token_usage, tool_calls, turns,
 * classifications, findings) and the ingest_state for its files. This is what makes the global exclude list
 * take effect on the NEXT ingest, incremental or full: add a project and its data leaves the DB.
 * Matches projects.path exactly or by path-prefix. Returns the number of sessions pruned.
 */
export function pruneExcluded(db: DB, excludedPaths: string[]): number {
  if (!excludedPaths.length) return 0;
  const projects = db.prepare("SELECT id, path FROM projects").all() as Array<{ id: string; path: string }>;
  const projIds = projects.filter((p) => excludedPaths.some((e) => p.path === e || p.path.startsWith(e + "/"))).map((p) => p.id);
  if (!projIds.length) return 0;

  db.exec("DROP TABLE IF EXISTS _prune");
  db.exec("CREATE TEMP TABLE _prune (id TEXT PRIMARY KEY)");
  const insP = db.prepare("INSERT OR IGNORE INTO _prune (id) VALUES (?)");
  const seed = db.prepare(`SELECT id FROM sessions WHERE project_id IN (${projIds.map(() => "?").join(",")})`).all(...projIds) as Array<{ id: string }>;
  db.transaction(() => {
    for (const s of seed) insP.run(s.id);
  })();
  // Transitive: subagents whose parent is being pruned (covers cross-project linkage). Fixpoint.
  const expand = db.prepare("INSERT OR IGNORE INTO _prune (id) SELECT id FROM sessions WHERE parent_session_id IN (SELECT id FROM _prune)");
  const cnt = db.prepare("SELECT COUNT(*) n FROM _prune");
  for (let prev = -1; ; ) {
    const n = (cnt.get() as { n: number }).n;
    if (n === prev) break;
    prev = n;
    expand.run();
  }
  const total = (cnt.get() as { n: number }).n;
  if (!total) {
    db.exec("DROP TABLE IF EXISTS _prune");
    return 0;
  }
  const files = (db.prepare("SELECT DISTINCT source_file f FROM events WHERE session_id IN (SELECT id FROM _prune) AND source_file IS NOT NULL").all() as Array<{ f: string }>).map((r) => r.f);

  db.pragma("foreign_keys = OFF");
  db.transaction(() => {
    db.exec("DELETE FROM findings WHERE session_id IN (SELECT id FROM _prune)");
    db.exec("DELETE FROM file_changes WHERE session_id IN (SELECT id FROM _prune)");
    for (const t of ["token_usage", "tool_calls", "turns", "events"]) db.exec(`DELETE FROM ${t} WHERE session_id IN (SELECT id FROM _prune)`);
    db.exec("DELETE FROM classifications WHERE scope = 'session' AND target_id IN (SELECT id FROM _prune)");
    db.exec("DELETE FROM sessions WHERE id IN (SELECT id FROM _prune)");
    const delState = db.prepare("DELETE FROM ingest_state WHERE file_path = ?");
    for (const f of files) delState.run(f);
    // Drop now-empty projects (an excluded project leaves no sessions behind).
    db.exec("DELETE FROM projects WHERE id NOT IN (SELECT DISTINCT project_id FROM sessions WHERE project_id IS NOT NULL)");
  })();
  db.pragma("foreign_keys = ON");
  db.exec("DROP TABLE IF EXISTS _prune");
  return total;
}

function durationMs(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, b - a);
}

/** Group a session's events into turns and return the turns + a uuid→turn_id map. */
export function buildTurns(
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

/**
 * Rebuild derived tables (turns, turn_id linkage, subagent parent linkage, session aggregates) from
 * the idempotent events/tool_calls tables.
 *
 * `dirty` is the set of session ids touched by this ingest run (incremental). When provided, only the
 * affected sessions are rebuilt — but the set is first expanded to its **linkage neighborhood** (the
 * subagent children spawned by a dirty session, and the parent session that spawned a dirty sidechain)
 * via a fixpoint, so cross-session parent/child links stay correct even when parent and child
 * transcripts arrive in different runs (ADR-010). When `dirty` is null/undefined (`--full`), every
 * session is rebuilt — the migration/reset path. Returns the expanded id set (or null for the full
 * path) so `classify()` can reuse it without re-expanding.
 */
export function rebuildDerived(db: DB, dirty?: Set<string> | null): Set<string> | null {
  const incremental = dirty != null;
  // Scope fragments: empty for the full rebuild, else restrict to the materialized _dirty temp table.
  const bySession = incremental ? " WHERE session_id IN (SELECT id FROM _dirty)" : "";
  const byId = incremental ? " WHERE id IN (SELECT id FROM _dirty)" : "";
  const andId = incremental ? " AND id IN (SELECT id FROM _dirty)" : "";
  const andSelfId = incremental ? " AND sessions.id IN (SELECT id FROM _dirty)" : "";

  if (incremental) {
    db.exec("DROP TABLE IF EXISTS _dirty");
    db.exec("CREATE TEMP TABLE _dirty (id TEXT PRIMARY KEY)");
    const ins = db.prepare("INSERT OR IGNORE INTO _dirty (id) VALUES (?)");
    db.transaction((ids: Iterable<string>) => {
      for (const id of ids) ins.run(id);
    })(dirty);
    // Fixpoint expansion to the linkage neighborhood: a dirty parent pulls in the children it spawned,
    // and a dirty child pulls in its spawner parent. Loop until the set stops growing (covers nested
    // subagents). Bounded by the session count.
    const expand = db.prepare(`
      INSERT OR IGNORE INTO _dirty (id)
        SELECT spawned_session_id FROM tool_calls
          WHERE session_id IN (SELECT id FROM _dirty) AND spawned_session_id IS NOT NULL
        UNION
        SELECT session_id FROM tool_calls
          WHERE spawned_session_id IN (SELECT id FROM _dirty)
        UNION
        -- structural (path-based) workflow linkage: a dirty parent pulls in its subagent children,
        -- and a dirty child pulls in its structural parent, so the fallback link stays correct when
        -- parent and child transcripts arrive in different runs (ADR-010).
        SELECT id FROM sessions
          WHERE spawn_parent_id IN (SELECT id FROM _dirty)
        UNION
        SELECT spawn_parent_id FROM sessions
          WHERE id IN (SELECT id FROM _dirty) AND spawn_parent_id IS NOT NULL
    `);
    const count = db.prepare("SELECT COUNT(*) n FROM _dirty");
    let prev = -1;
    for (;;) {
      const n = (count.get() as { n: number }).n;
      if (n === prev) break;
      prev = n;
      expand.run();
    }
  }

  // Recompute turns from the (idempotent) events table.
  // Null referencing turn_ids BEFORE deleting turns (FK: events/token_usage/tool_calls/sessions -> turns).
  db.exec(`UPDATE events SET turn_id = NULL${bySession}`);
  db.exec(`UPDATE token_usage SET turn_id = NULL${bySession}`);
  db.exec(`UPDATE tool_calls SET turn_id = NULL${bySession}`);
  // Clear skill-version links for the scope so changed/removed bodies don't leave a stale link.
  db.exec(`UPDATE tool_calls SET skill_id = NULL${bySession}`);
  db.exec(`UPDATE sessions SET parent_turn_id = NULL${byId}`);
  db.exec(`DELETE FROM turns${bySession}`);

  const sessionIds = db.prepare(`SELECT id FROM sessions${byId}`).all() as Array<{ id: string }>;
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
  db.exec(`UPDATE token_usage SET turn_id = (SELECT turn_id FROM events WHERE events.uuid = token_usage.event_uuid)${bySession}`);
  db.exec(`UPDATE tool_calls SET turn_id = (SELECT turn_id FROM events WHERE events.uuid = tool_calls.event_uuid)${bySession}`);

  // Link each Skill tool_call to a content-addressed skill *version*. A firing injects the full
  // SKILL.md body as an isMeta user event right after the launch; we pair each Skill tool_call with
  // the following injection (by skill-name token, ARGUMENTS as tiebreak), normalize + hash the body,
  // UPSERT the version, and stamp tool_calls.skill_id. Firings without a captured body keep skill_id
  // NULL (skill_name stays set). Runs over the same scoped session set as the turn rebuild.
  {
    const selEventsOrdered = db.prepare(
      "SELECT uuid, type, is_meta, timestamp, text FROM events WHERE session_id = ?",
    );
    const selSkillCalls = db.prepare(
      "SELECT id, event_uuid, skill_name, input_json FROM tool_calls WHERE session_id = ? AND tool_name = 'Skill'",
    );
    const upsertSkill = db.prepare(
      `INSERT INTO skills (id, name, base_dir, body, summary, body_bytes, first_seen, last_seen)
       VALUES (@id, @name, @base_dir, @body, @summary, @body_bytes, @ts, @ts)
       ON CONFLICT(id) DO UPDATE SET
         last_seen  = MAX(last_seen,  excluded.last_seen),
         first_seen = MIN(first_seen, excluded.first_seen),
         base_dir   = excluded.base_dir`,
    );
    const linkCall = db.prepare("UPDATE tool_calls SET skill_id = ? WHERE id = ?");

    const linkTx = db.transaction(() => {
      for (const { id: sid } of sessionIds) {
        const calls = selSkillCalls.all(sid) as Array<{ id: string; event_uuid: string | null; skill_name: string | null; input_json: string | null }>;
        if (!calls.length) continue;
        const events = (selEventsOrdered.all(sid) as Array<{ uuid: string; type: string; is_meta: number; timestamp: string | null; text: string | null }>).sort(
          (x, y) => (x.timestamp ?? "").localeCompare(y.timestamp ?? "") || x.uuid.localeCompare(y.uuid),
        );
        const callByEvent = new Map<string, typeof calls>();
        for (const c of calls) {
          if (!c.event_uuid) continue;
          const arr = callByEvent.get(c.event_uuid) ?? [];
          arr.push(c);
          callByEvent.set(c.event_uuid, arr);
        }
        // Queue of pending Skill calls awaiting their body injection, keyed by skill-name token.
        const pending = new Map<string, Array<{ id: string; args: string | null }>>();
        for (const e of events) {
          const here = callByEvent.get(e.uuid);
          if (here) {
            for (const c of here) {
              if (!c.skill_name) continue;
              const key = skillNameKey(c.skill_name);
              let args: string | null = null;
              try {
                args = c.input_json ? (JSON.parse(c.input_json).args ?? null) : null;
                if (typeof args === "string") args = args.trim() || null;
                else if (args != null) args = JSON.stringify(args);
              } catch {
                /* keep null */
              }
              const arr = pending.get(key) ?? [];
              arr.push({ id: c.id, args });
              pending.set(key, arr);
            }
          }
          if (e.is_meta !== 1 || e.type !== "user" || !e.text) continue;
          const inj = parseSkillInjection(e.text);
          if (!inj) continue;
          const queue = pending.get(inj.nameKey);
          if (!queue || !queue.length) continue;
          // Prefer a call whose args match the injection's ARGUMENTS; else take the earliest pending.
          let idx = inj.args != null ? queue.findIndex((q) => q.args === inj.args) : -1;
          if (idx < 0) idx = 0;
          const [match] = queue.splice(idx, 1);
          const c = calls.find((x) => x.id === match.id)!;
          const name = c.skill_name!;
          const vid = skillVersionId(name, inj.body);
          upsertSkill.run({
            id: vid,
            name,
            base_dir: inj.baseDir,
            body: inj.body,
            summary: skillSummary(inj.body),
            body_bytes: Buffer.byteLength(inj.body, "utf8"),
            ts: e.timestamp,
          });
          linkCall.run(vid, match.id);
        }
      }
    });
    linkTx();
  }

  // Link subagent (sidechain) sessions back to the parent turn/session that spawned them. The
  // deterministic key is the spawning Task/Agent tool_call's spawned_session_id (== this session id).
  db.exec(`
    UPDATE sessions SET
      parent_session_id = (SELECT tc.session_id FROM tool_calls tc WHERE tc.spawned_session_id = sessions.id),
      parent_turn_id    = (SELECT tc.turn_id    FROM tool_calls tc WHERE tc.spawned_session_id = sessions.id)
    WHERE EXISTS (SELECT 1 FROM tool_calls tc WHERE tc.spawned_session_id = sessions.id)${andSelfId}
  `);

  // Workflow fan-out carries no toolUseResult.agentId, so the link above never fires for it
  // (finding #1). But the launching Workflow tool_call's result DOES carry a run id (wf_<id>), and the
  // run's subagents nest under …/subagents/workflows/<runId>/ — so sessions.workflow_run_id matches
  // tool_calls.workflow_run_id. That gives workflow agents BOTH their parent session and the exact
  // launching turn. (LIMIT 1: a run id maps to a single Workflow tool_call.)
  db.exec(`
    UPDATE sessions SET
      parent_session_id = COALESCE(parent_session_id, (SELECT tc.session_id FROM tool_calls tc WHERE tc.workflow_run_id = sessions.workflow_run_id LIMIT 1)),
      parent_turn_id    = COALESCE(parent_turn_id,    (SELECT tc.turn_id    FROM tool_calls tc WHERE tc.workflow_run_id = sessions.workflow_run_id LIMIT 1))
    WHERE sessions.workflow_run_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM tool_calls tc WHERE tc.workflow_run_id = sessions.workflow_run_id)${andSelfId}
  `);

  // Final fallback for any sidechain still unlinked (e.g. its Workflow tool_call/runId wasn't
  // captured, or a non-workflow nested agent): attribute to the structural parent captured at ingest
  // from the transcript's directory location (<parent>/subagents/…) — the deterministic,
  // redaction-surviving signal. parent_turn_id stays NULL here. Tokens stay siloed → no double-count.
  db.exec(`
    UPDATE sessions SET parent_session_id = spawn_parent_id
    WHERE parent_session_id IS NULL
      AND spawn_parent_id IS NOT NULL
      AND spawn_parent_id IN (SELECT id FROM sessions)${andSelfId}
  `);

  // Recompute session aggregates from events/turns.
  db.exec(`
    UPDATE sessions SET
      event_count = (SELECT COUNT(*) FROM events e WHERE e.session_id = sessions.id),
      started_at  = (SELECT MIN(timestamp) FROM events e WHERE e.session_id = sessions.id),
      ended_at    = (SELECT MAX(timestamp) FROM events e WHERE e.session_id = sessions.id),
      turn_count  = (SELECT COUNT(*) FROM turns t WHERE t.session_id = sessions.id),
      is_sidechain = (SELECT CASE WHEN MIN(is_sidechain) = 1 THEN 1 ELSE 0 END FROM events e WHERE e.session_id = sessions.id)${byId}
  `);
  db.exec(`
    UPDATE sessions SET duration_ms =
      CAST((julianday(ended_at) - julianday(started_at)) * 86400000 AS INTEGER)
    WHERE started_at IS NOT NULL AND ended_at IS NOT NULL${andId}
  `);

  // Prune phantom sessions: any with zero events is not a real transcript. discover() walks every
  // *.jsonl under projects/, which sweeps up non-transcript files that happen to live there — e.g.
  // a Workflow tool's `journal.jsonl` (lines carry no `uuid`, so they yield no events). insSessionStub
  // still created a row (and they all share the basename → one phantom "journal" session). A zero-event
  // session has no events/turns/token_usage/tool_calls referencing it, so the delete is FK-safe; the
  // orphaned-classification sweep keeps the (no-FK) classifications table from accumulating dead rows
  // (kept global — it is one row per session and must catch any now-missing target).
  db.exec(`DELETE FROM sessions WHERE event_count = 0${andId}`);
  db.exec("DELETE FROM classifications WHERE scope = 'session' AND target_id NOT IN (SELECT id FROM sessions)");
  // Security findings for a now-missing session (kept global — detect() runs after this rebuild and
  // only rescans the dirty scope, so a vanished non-dirty session's rows must be swept here).
  db.exec("DELETE FROM findings WHERE session_id NOT IN (SELECT id FROM sessions)");
  // Same sweep for file_changes (ADR-022): deriveFileChanges also runs post-rebuild on the dirty
  // scope only, so a vanished non-dirty session's rows must be cleared here.
  db.exec("DELETE FROM file_changes WHERE session_id NOT IN (SELECT id FROM sessions)");
  // Sweep skill versions no longer referenced by any tool_call. Full path only: an incremental run
  // only re-derives dirty sessions, so a version could still be referenced by a non-dirty session.
  if (!incremental) {
    db.exec("DELETE FROM skills WHERE id NOT IN (SELECT skill_id FROM tool_calls WHERE skill_id IS NOT NULL)");
  }

  if (incremental) {
    const expanded = new Set(
      (db.prepare("SELECT id FROM _dirty").all() as Array<{ id: string }>).map((r) => r.id),
    );
    db.exec("DROP TABLE IF EXISTS _dirty");
    return expanded;
  }
  return null;
}

export interface IngestStatements {
  insAgent: Stmt;
  insSource: Stmt;
  getState: Stmt;
  setState: Stmt;
  insEvent: Stmt;
  insTokens: Stmt;
  insTool: Stmt;
  patchTool: Stmt;
  upsertProject: Stmt;
  insSessionStub: Stmt;
  upsertSession: Stmt;
}

export function prepareStatements(db: DB): IngestStatements {
  return {
    insAgent: db.prepare("INSERT OR IGNORE INTO agents (id, name, kind) VALUES (?, ?, 'cli')"),
    insSource: db.prepare(
      `INSERT INTO sources (id, label, agent_id, config_dir) VALUES (@id, @label, @agent_id, @config_dir)
       ON CONFLICT(id) DO UPDATE SET label=excluded.label, agent_id=excluded.agent_id, config_dir=excluded.config_dir`,
    ),
    getState: db.prepare("SELECT size, mtime_ms, sha256, events_ingested FROM ingest_state WHERE file_path = ?"),
    setState: db.prepare(
      `INSERT INTO ingest_state (file_path, size, mtime_ms, sha256, events_ingested, ingested_at)
       VALUES (@file_path, @size, @mtime_ms, @sha256, @events_ingested, @ingested_at)
       ON CONFLICT(file_path) DO UPDATE SET
         size=excluded.size, mtime_ms=excluded.mtime_ms, sha256=excluded.sha256,
         events_ingested=excluded.events_ingested, ingested_at=excluded.ingested_at`,
    ),
    insEvent: db.prepare(
      `INSERT INTO events (uuid, session_id, turn_id, parent_uuid, seq, type, role, timestamp, model, is_sidechain, is_meta, text, raw_json, source_file)
       VALUES (@uuid, @session_id, @turn_id, @parent_uuid, @seq, @type, @role, @timestamp, @model, @is_sidechain, @is_meta, @text, @raw_json, @source_file)
       ON CONFLICT(uuid) DO NOTHING`,
    ),
    insTokens: db.prepare(
      // Bare ON CONFLICT (no target) so the insert is skipped on EITHER the event_uuid PK or the
      // unique (session_id, message_id) index — the latter collapses a response's repeated
      // per-content-block usage lines into a single row.
      `INSERT INTO token_usage (event_uuid, session_id, turn_id, message_id, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, service_tier)
       VALUES (@event_uuid, @session_id, @turn_id, @message_id, @model, @input_tokens, @output_tokens, @cache_creation_input_tokens, @cache_read_input_tokens, @service_tier)
       ON CONFLICT DO NOTHING`,
    ),
    insTool: db.prepare(
      `INSERT INTO tool_calls (id, event_uuid, session_id, turn_id, tool_name, caller, skill_name, skill_id, agent_type, spawned_session_id, workflow_run_id, workflow_name, resolved_model, status, total_duration_ms, total_tokens, total_tool_use_count, input_json, result_summary)
       VALUES (@id, @event_uuid, @session_id, @turn_id, @tool_name, @caller, @skill_name, @skill_id, @agent_type, @spawned_session_id, @workflow_run_id, @workflow_name, @resolved_model, @status, @total_duration_ms, @total_tokens, @total_tool_use_count, @input_json, @result_summary)
       ON CONFLICT(id) DO NOTHING`,
    ),
    patchTool: db.prepare(
      `UPDATE tool_calls SET
         status = COALESCE(@status, status),
         agent_type = COALESCE(@agent_type, agent_type),
         spawned_session_id = COALESCE(@spawned_session_id, spawned_session_id),
         workflow_run_id = COALESCE(@workflow_run_id, workflow_run_id),
         workflow_name = COALESCE(@workflow_name, workflow_name),
         resolved_model = COALESCE(@resolved_model, resolved_model),
         total_duration_ms = COALESCE(@total_duration_ms, total_duration_ms),
         total_tokens = COALESCE(@total_tokens, total_tokens),
         total_tool_use_count = COALESCE(@total_tool_use_count, total_tool_use_count),
         result_summary = COALESCE(@result_summary, result_summary)
       WHERE id = @tool_use_id`,
    ),
    upsertProject: db.prepare(
      `INSERT INTO projects (id, agent_id, path, encoded_dir, first_seen, last_seen)
       VALUES (@id, @agent_id, @path, @encoded_dir, @now, @now)
       ON CONFLICT(id) DO UPDATE SET last_seen = @now, encoded_dir = COALESCE(excluded.encoded_dir, encoded_dir)`,
    ),
    insSessionStub: db.prepare("INSERT OR IGNORE INTO sessions (id, agent_id, source_id) VALUES (?, ?, ?)"),
    upsertSession: db.prepare(
      `INSERT INTO sessions (id, agent_id, source_id, project_id, slug, ai_title, cli_version, entrypoint, git_branch, spawn_parent_id, workflow_run_id)
       VALUES (@id, @agent_id, @source_id, @project_id, @slug, @ai_title, @cli_version, @entrypoint, @git_branch, @spawn_parent_id, @workflow_run_id)
       ON CONFLICT(id) DO UPDATE SET
         source_id = COALESCE(excluded.source_id, source_id),
         project_id = COALESCE(excluded.project_id, project_id),
         slug = COALESCE(excluded.slug, slug),
         ai_title = COALESCE(excluded.ai_title, ai_title),
         cli_version = COALESCE(excluded.cli_version, cli_version),
         entrypoint = COALESCE(excluded.entrypoint, entrypoint),
         git_branch = COALESCE(excluded.git_branch, git_branch),
         spawn_parent_id = COALESCE(excluded.spawn_parent_id, spawn_parent_id),
         workflow_run_id = COALESCE(excluded.workflow_run_id, workflow_run_id)`,
    ),
  };
}

/**
 * Ingest one transcript file's lines in a single transaction: parse each line via the adapter,
 * insert events/token_usage/tool_calls (deduped by their keys), patch tool results, and upsert the
 * session + project metadata. `lines` is an iterable of newline-stripped lines — the caller chooses
 * whole-file read (small files) or a streaming reader (large files), so this engine never holds the
 * full file as one string. `meta` carries the disk stats recorded into ingest_state (tests pass
 * synthetic values). Derived tables (turns, linkage, aggregates) are rebuilt separately afterwards.
 */
export function ingestFile(
  db: DB,
  stmts: IngestStatements,
  adapter: SourceAdapter,
  file: SourceFile,
  lines: Iterable<string>,
  meta: { size: number; mtimeMs: number; hash: string },
  now: string,
  stats: IngestStats,
): void {
  const sessionMeta: Record<string, any> = {};
  let eventsInFile = 0;

  const tx = db.transaction(() => {
    // Ensure the session row exists before any event references it (FK).
    stmts.insSessionStub.run(file.sessionId, adapter.agentId, file.sourceId);
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
        // raw_json is stored gzip-compressed (ADR-011); compress at this single write chokepoint so
        // adapters stay agent-agnostic and emit a plain string.
        const info = stmts.insEvent.run({ ...parsed.event, raw_json: packRaw(parsed.event.raw_json) });
        if (info.changes > 0) {
          stats.newEvents++;
          eventsInFile++;
        }
      }
      if (parsed.tokenUsage) stmts.insTokens.run(parsed.tokenUsage);
      if (parsed.toolCalls) for (const tc of parsed.toolCalls) stmts.insTool.run(tc);
      if (parsed.toolResults)
        for (const tr of parsed.toolResults)
          stmts.patchTool.run({
            tool_use_id: tr.tool_use_id,
            status: tr.status ?? null,
            agent_type: tr.agent_type ?? null,
            spawned_session_id: tr.spawned_session_id ?? null,
            workflow_run_id: tr.workflow_run_id ?? null,
            workflow_name: tr.workflow_name ?? null,
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
      stmts.upsertProject.run({
        id: projectId,
        agent_id: adapter.agentId,
        path: sessionMeta.cwd,
        encoded_dir: file.encodedDir || null,
        now,
      });
    }
    stmts.upsertSession.run({
      id: file.sessionId,
      agent_id: adapter.agentId,
      source_id: file.sourceId,
      project_id: projectId,
      slug: sessionMeta.slug ?? null,
      ai_title: sessionMeta.ai_title ?? null,
      cli_version: sessionMeta.cli_version ?? null,
      entrypoint: sessionMeta.entrypoint ?? null,
      git_branch: sessionMeta.git_branch ?? null,
      spawn_parent_id: file.parentSessionId ?? null,
      workflow_run_id: file.workflowRunId ?? null,
    });

    stmts.setState.run({
      file_path: file.path,
      size: meta.size,
      mtime_ms: Math.trunc(meta.mtimeMs),
      sha256: meta.hash,
      events_ingested: eventsInFile,
      ingested_at: now,
    });
  });
  tx();
}
