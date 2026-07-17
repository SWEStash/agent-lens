import Database from "better-sqlite3";
import { costForUsage, SCHEMA_VERSION, unpackRaw, severityRank, SECURITY_CATEGORIES, errorKind } from "@agent-lens/core";

export type DB = Database.Database;

export function openReadonly(file: string): DB {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  return db;
}

/**
 * Compare the DB's stamped schema version against the version this server build expects. `stale` means
 * the on-disk DB was written by an older schema (a bump requires `agent-lens ingest --full` to rebuild)
 * — the UI surfaces this so a mismatch doesn't silently show missing/empty columns. `db_version` is null
 * on an unstamped/never-ingested DB (treated as not-stale: nothing to warn about yet).
 */
export function schemaStatus(db: DB): { db_version: number | null; expected: number; stale: boolean } {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  const dbVersion = row ? Number(row.value) : null;
  const db_version = dbVersion != null && Number.isFinite(dbVersion) ? dbVersion : null;
  return { db_version, expected: SCHEMA_VERSION, stale: db_version != null && db_version !== SCHEMA_VERSION };
}

/**
 * Wall-clock time of the most recent ingest run that wrote anything, as an ISO8601 string (or null on
 * a never-ingested DB). Every archive file touched by a run gets the same `ingested_at` stamp, so the
 * max across `ingest_state` is exactly "data last refreshed at". Powers the header freshness readout.
 */
export function lastIngested(db: DB): string | null {
  const row = db.prepare("SELECT MAX(ingested_at) AS last FROM ingest_state").get() as { last: string | null };
  return row?.last ?? null;
}

/**
 * Split a raw transcript line's message content into natural text vs thinking. Accepts the stored
 * `events.raw_json` value, which is a gzip BLOB (Buffer) post-ADR-011 but may be a legacy plain string;
 * `unpackRaw` normalizes both.
 */
export function extractParts(rawJson: string | Buffer): { text: string | null; thinking: string | null } {
  let text = "";
  let thinking = "";
  try {
    const content = JSON.parse(unpackRaw(rawJson))?.message?.content;
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "text" && typeof b.text === "string") text += (text ? "\n" : "") + b.text;
        else if (b?.type === "thinking" && typeof b.thinking === "string")
          thinking += (thinking ? "\n" : "") + b.thinking;
      }
    }
  } catch {
    /* ignore */
  }
  return { text: text || null, thinking: thinking || null };
}

export interface SessionFilters {
  source?: string;
  project?: string;
  model?: string;
  q?: string;
  from?: string;
  to?: string;
  kind?: "main" | "subagent";
  /** Keep only sessions that have ≥1 finding of one of these severities. */
  severity?: string[];
  /** Keep only sessions that have ≥1 errored tool call of one of these error types. */
  errorType?: string[];
  /** Column to sort the whole filtered list by (before pagination). Defaults to "started". */
  sort?: "started" | "title" | "turns" | "tokens" | "cost" | "duration" | "errors" | "security";
  dir?: "asc" | "desc";
  limit: number;
  offset: number;
}

export function listSources(db: DB) {
  return db
    .prepare(
      // Count MAIN sessions only (is_sidechain = 0): the dropdown filters the session list, which
      // defaults to main-only, so a source's count must match what you'd see — not be inflated by the
      // many subagent sidechains each task spawns.
      `SELECT s.id, s.label, s.agent_id, s.config_dir,
              (SELECT COUNT(*) FROM sessions x WHERE x.source_id = s.id AND x.is_sidechain = 0) AS session_count
       FROM sources s ORDER BY s.label`,
    )
    .all();
}

export function listProjects(db: DB) {
  return db
    .prepare(
      `SELECT p.id, p.path,
              (SELECT COUNT(*) FROM sessions x WHERE x.project_id = p.id AND x.is_sidechain = 0) AS session_count
       FROM projects p ORDER BY session_count DESC, p.path`,
    )
    .all();
}

export function listModels(db: DB) {
  return db
    .prepare(`SELECT DISTINCT model FROM token_usage WHERE model IS NOT NULL ORDER BY model`)
    .all()
    .map((r: any) => r.model);
}

/**
 * Turn a user's search box input into a safe FTS5 MATCH expression. The raw string is otherwise
 * parsed as FTS5 *query syntax*, so a hyphen, colon (column filter), or bareword operator throws
 * (e.g. "swe-workflow" → `SQLITE_ERROR: no such column: workflow`). We treat the input as literal
 * terms: split on whitespace and wrap each token in double quotes (doubling embedded quotes per
 * FTS5 escaping), joined by space (implicit AND). Phrasing also lets the tokenizer split intra-token
 * punctuation, so "swe-workflow" matches the adjacent tokens "swe workflow". Returns "" for input
 * with no usable tokens (caller guards on a non-empty trimmed query). */
function toFtsQuery(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
}

export function listSessions(db: DB, f: SessionFilters) {
  const where: string[] = [];
  const params: any[] = [];
  if (f.source) (where.push("s.source_id = ?"), params.push(f.source));
  if (f.project) (where.push("s.project_id = ?"), params.push(f.project));
  // Date-inclusive on both ends (see findingWhere): a picked `to` day must include that day's sessions.
  if (f.from) (where.push("date(s.started_at) >= date(?)"), params.push(f.from));
  if (f.to) (where.push("date(s.started_at) <= date(?)"), params.push(f.to));
  if (f.kind === "main") where.push("s.is_sidechain = 0");
  if (f.kind === "subagent") where.push("s.is_sidechain = 1");
  // Multi-select: session has ≥1 finding of any listed severity / ≥1 errored tool call of any listed type.
  if (f.severity?.length) {
    where.push(`EXISTS (SELECT 1 FROM findings fd WHERE fd.session_id = s.id AND fd.severity IN (${f.severity.map(() => "?").join(",")}))`);
    params.push(...f.severity);
  }
  if (f.errorType?.length) {
    where.push(`EXISTS (SELECT 1 FROM tool_calls tc WHERE tc.session_id = s.id AND tc.error_type IN (${f.errorType.map(() => "?").join(",")}))`);
    params.push(...f.errorType);
  }
  if (f.model) {
    where.push("EXISTS (SELECT 1 FROM token_usage t WHERE t.session_id = s.id AND t.model = ?)");
    params.push(f.model);
  }
  if (f.q && f.q.trim()) {
    // Match transcript text (FTS) OR the session's own name (slug/ai_title) OR its project path, so a
    // query like "fix-youtube-embed-csp-policy" finds the session by slug even when that string never
    // appears verbatim in an event. A project-path *subquery* (not a join on p.path) keeps the
    // un-joined COUNT(*) query above valid. SQLite LIKE is case-insensitive for ASCII.
    const like = `%${f.q.trim()}%`;
    where.push(
      `(s.id IN (SELECT DISTINCT e.session_id FROM events e JOIN events_fts f ON f.rowid = e.rowid WHERE events_fts MATCH ?)
        OR s.slug LIKE ? OR s.ai_title LIKE ?
        OR s.project_id IN (SELECT id FROM projects WHERE path LIKE ?))`,
    );
    params.push(toFtsQuery(f.q), like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = (db.prepare(`SELECT COUNT(*) n FROM sessions s ${whereSql}`).get(...params) as any).n;

  const baseSelect = `SELECT s.id, s.ai_title, s.slug, s.source_id, s.is_sidechain, s.started_at, s.ended_at,
              s.duration_ms, s.event_count, s.turn_count, p.path AS project_path,
              (SELECT GROUP_CONCAT(DISTINCT model) FROM token_usage t WHERE t.session_id = s.id) AS models,
              (SELECT COUNT(*) FROM tool_calls tc WHERE tc.session_id = s.id) AS tool_call_count,
              (SELECT COUNT(*) FROM tool_calls tc WHERE tc.session_id = s.id AND tc.status = 'error') AS tool_error_count,
              (SELECT COUNT(*) FROM findings fd WHERE fd.session_id = s.id) AS finding_count,
              (SELECT fd.severity FROM findings fd WHERE fd.session_id = s.id
                 ORDER BY CASE fd.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 WHEN 'info' THEN 0 ELSE -1 END DESC
                 LIMIT 1) AS worst_severity
       FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
       ${whereSql}`;

  // Columns sortable directly in SQL (stable-paginated with an id tiebreak). tokens/cost aren't stored
  // — they're derived from token_usage with per-model pricing — so those sort over the whole matching
  // set in JS below.
  const NATIVE_ORDER: Record<string, string> = {
    started: "s.started_at",
    title: "COALESCE(s.ai_title, s.slug)",
    turns: "s.turn_count",
    duration: "s.duration_ms",
  };
  const sortKey = f.sort ?? "started";
  const sqlDir = f.dir === "asc" ? "ASC" : "DESC";

  // Columns sorted in JS over the whole matching set (derived/subquery metrics that the paged SQL
  // ORDER BY can't reach consistently): tokens/cost (costed below) plus the error/finding roll-ups.
  const JS_SORT = new Set(["tokens", "cost", "errors", "security"]);
  let rows: any[];
  if (JS_SORT.has(sortKey)) {
    // Whole-list sort by a derived metric: materialize every matching session, cost them all, sort,
    // then take the page. Heavier than the SQL path but the only way to page a JS-computed column
    // consistently. Fine at this tool's scale (personal analytics).
    const all = db.prepare(baseSelect).all(...params) as any[];
    attachSessionCost(db, all);
    const sign = f.dir === "asc" ? 1 : -1;
    const metric = (r: any): number => {
      switch (sortKey) {
        case "tokens": return r.tokens;
        case "cost": return r.cost;
        case "errors": return r.tool_error_count ?? 0;
        // Security: rank by worst severity (info=0 … critical=4; none = -1), finding count as tiebreak.
        case "security": return (severityRank(r.worst_severity ?? "") + 1) * 1e6 + (r.finding_count ?? 0);
        default: return 0;
      }
    };
    all.sort((a, b) => {
      const c = (metric(a) - metric(b)) * sign;
      return c !== 0 ? c : String(a.id).localeCompare(String(b.id));
    });
    rows = all.slice(f.offset, f.offset + f.limit);
  } else {
    const orderCol = NATIVE_ORDER[sortKey] ?? NATIVE_ORDER.started;
    rows = db
      .prepare(`${baseSelect} ORDER BY ${orderCol} ${sqlDir}, s.id ASC LIMIT ? OFFSET ?`)
      .all(...params, f.limit, f.offset) as any[];
    attachSessionCost(db, rows);
  }

  return { total, sessions: rows };
}

/** Attach per-session `tokens`, `token_split`, `cost` (USD, cache-aware) and `title` in place. Costs
 * are grouped by model so per-model rates apply. IDs are chunked so the whole-list sort path (which can
 * pass thousands of sessions) stays under SQLite's bound-parameter limit. */
function attachSessionCost(db: DB, rows: any[]) {
  type Acc = { tokens: number; cost: number; split: { input: number; output: number; cache_creation: number; cache_read: number } };
  const costBySession = new Map<string, Acc>();
  const ids = rows.map((r) => r.id);
  const CHUNK = 800;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    const ph = batch.map(() => "?").join(",");
    const usage = db
      .prepare(
        `SELECT session_id, model,
                SUM(input_tokens) i, SUM(output_tokens) o,
                SUM(cache_creation_input_tokens) cw, SUM(cache_read_input_tokens) cr
         FROM token_usage WHERE session_id IN (${ph}) GROUP BY session_id, model`,
      )
      .all(...batch) as any[];
    for (const u of usage) {
      const acc = costBySession.get(u.session_id) ?? { tokens: 0, cost: 0, split: { input: 0, output: 0, cache_creation: 0, cache_read: 0 } };
      acc.tokens += u.i + u.o + u.cw + u.cr;
      acc.split.input += u.i;
      acc.split.output += u.o;
      acc.split.cache_creation += u.cw;
      acc.split.cache_read += u.cr;
      acc.cost += costForUsage(u.model, {
        input_tokens: u.i,
        output_tokens: u.o,
        cache_creation_input_tokens: u.cw,
        cache_read_input_tokens: u.cr,
      });
      costBySession.set(u.session_id, acc);
    }
  }
  for (const r of rows) {
    const c = costBySession.get(r.id);
    r.tokens = c?.tokens ?? 0;
    r.token_split = c?.split ?? { input: 0, output: 0, cache_creation: 0, cache_read: 0 };
    r.cost = c ? Number(c.cost.toFixed(4)) : 0;
    r.title = r.ai_title || r.slug || null;
  }
}

export function getSession(db: DB, id: string) {
  const session = db
    .prepare(
      `SELECT s.*, p.path AS project_path FROM sessions s
       LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = ?`,
    )
    .get(id) as any;
  if (!session) return null;

  const turns = db.prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY seq").all(id);
  const eventRows = db
    .prepare(
      `SELECT uuid, type, role, timestamp, model, is_sidechain, turn_id, raw_json
       FROM events WHERE session_id = ? ORDER BY timestamp, seq`,
    )
    .all(id) as any[];
  const toolRows = db
    .prepare(
      `SELECT id, event_uuid, tool_name, skill_name, skill_id, agent_type, spawned_session_id,
              workflow_run_id, workflow_name, status, error_type,
              total_duration_ms, total_tokens, input_json, result_summary,
              (SELECT COUNT(*) FROM sessions s WHERE s.workflow_run_id = tool_calls.workflow_run_id) AS workflow_agent_count
       FROM tool_calls WHERE session_id = ?`,
    )
    .all(id) as any[];

  // Spilled full tool outputs: when a result_summary is the "Full output saved to: …/tool-results/
  // <name>.txt" marker (the transcript's 280-char stand-in), attach the un-truncated text from
  // tool_results so the UI can expand it. Keyed by (session_id, name); guarded for a pre-ingest DB.
  if (tableExists(db, "tool_results")) {
    const getFull = db.prepare("SELECT text, bytes FROM tool_results WHERE session_id = ? AND name = ?");
    for (const t of toolRows) {
      const m = typeof t.result_summary === "string" ? t.result_summary.match(/tool-results\/([A-Za-z0-9_-]+)\.txt/) : null;
      if (!m) continue;
      const full = getFull.get(id, m[1]) as { text: string; bytes: number } | undefined;
      if (full) t.full_result = { text: full.text, bytes: full.bytes };
    }
  }

  // Security findings (ADR-017): attach each tool call's findings inline (for the transcript severity
  // badge + "why" panel) and collect a session-level list for the header summary. Guarded for a
  // read-only pre-ingest DB whose schema predates the findings table.
  const sessionFindings: any[] = [];
  if (tableExists(db, "findings")) {
    const findingRows = db
      .prepare(
        `SELECT id, tool_call_id, event_uuid, turn_id, rule_id, category, framework_ref, severity, title, evidence, signals_json
         FROM findings WHERE session_id = ?`,
      )
      .all(id) as any[];
    const byToolCall = new Map<string, any[]>();
    for (const fr of findingRows) {
      const f = {
        id: fr.id,
        tool_call_id: fr.tool_call_id,
        event_uuid: fr.event_uuid,
        turn_id: fr.turn_id,
        rule_id: fr.rule_id,
        category: fr.category,
        framework_ref: fr.framework_ref,
        severity: fr.severity,
        title: fr.title,
        evidence: fr.evidence,
        signals: safeJson(fr.signals_json),
      };
      sessionFindings.push(f);
      if (fr.tool_call_id) (byToolCall.get(fr.tool_call_id) ?? byToolCall.set(fr.tool_call_id, []).get(fr.tool_call_id))!.push(f);
    }
    for (const t of toolRows) t.findings = byToolCall.get(t.id) ?? [];
    // Most-severe first so a session banner can lead with the worst.
    sessionFindings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  }

  const toolsByEvent = new Map<string, any[]>();
  for (const t of toolRows) {
    if (!t.event_uuid) continue;
    (toolsByEvent.get(t.event_uuid) ?? toolsByEvent.set(t.event_uuid, []).get(t.event_uuid))!.push(t);
  }

  const events = eventRows.map((e) => {
    const { text, thinking } = extractParts(e.raw_json);
    return {
      uuid: e.uuid,
      type: e.type,
      role: e.role,
      timestamp: e.timestamp,
      model: e.model,
      is_sidechain: e.is_sidechain,
      turn_id: e.turn_id,
      text,
      thinking,
      toolCalls: toolsByEvent.get(e.uuid) ?? [],
    };
  });

  const usage = db
    .prepare(
      `SELECT model, SUM(input_tokens) i, SUM(output_tokens) o,
              SUM(cache_creation_input_tokens) cw, SUM(cache_read_input_tokens) cr
       FROM token_usage WHERE session_id = ? GROUP BY model`,
    )
    .all(id) as any[];
  // Keep the token categories split so the UI can show input/output/cache-write/cache-read
  // separately. Cache stays IN the total and IS cost-attributed (at its discounted rate) — it is
  // differentiated, never dropped.
  const split = { input: 0, output: 0, cache_creation: 0, cache_read: 0 };
  let cost = 0;
  for (const u of usage) {
    split.input += u.i;
    split.output += u.o;
    split.cache_creation += u.cw;
    split.cache_read += u.cr;
    cost += costForUsage(u.model, {
      input_tokens: u.i,
      output_tokens: u.o,
      cache_creation_input_tokens: u.cw,
      cache_read_input_tokens: u.cr,
    });
  }
  session.tokens = split.input + split.output + split.cache_creation + split.cache_read;
  session.token_split = split;
  session.cost = Number(cost.toFixed(4));
  session.title = session.ai_title || session.slug || null;

  // Heuristic classification (Phase 4): category + complexity + the signals that produced them
  // (tool/skill mix, LoC, files, subagent count) — already captured in signals_json by the classifier.
  const cls = db
    .prepare(
      `SELECT category, complexity_score, complexity_band, signals_json, classifier_version
       FROM classifications WHERE scope = 'session' AND target_id = ?`,
    )
    .get(id) as any;
  let classification: any = null;
  if (cls) {
    let signals: any = null;
    try {
      signals = cls.signals_json ? JSON.parse(cls.signals_json) : null;
    } catch {
      /* ignore malformed */
    }
    classification = {
      category: cls.category,
      complexity_score: cls.complexity_score,
      complexity_band: cls.complexity_band,
      classifier_version: cls.classifier_version,
      signals,
    };
  }

  // Subagent linkage (schema v3): if this is a sidechain session, resolve the parent turn/session
  // that spawned it so the UI can offer a "spawned by" crumb back to the originating turn.
  let parent: { id: string; title: string | null; turn_seq: number | null } | null = null;
  if (session.parent_session_id) {
    const p = db
      .prepare(
        `SELECT ps.id, ps.ai_title, ps.slug, t.seq AS turn_seq
         FROM sessions ps LEFT JOIN turns t ON t.id = ?
         WHERE ps.id = ?`,
      )
      .get(session.parent_turn_id, session.parent_session_id) as any;
    if (p) parent = { id: p.id, title: p.ai_title || p.slug || null, turn_seq: p.turn_seq ?? null };
  }

  // Spawned subagents (schema v3): sessions whose parent_session_id points back here. Nesting them
  // under the parent is why the flat session list defaults to main-only — a task with N subagents is
  // one row with N children, not N+1 sibling rows sharing the same slug.
  // Subagent metadata sidecars (session_meta) supply the authoritative agentType/description/spawnDepth
  // — LEFT JOIN so a subagent still lists when its meta hasn't been ingested (or the table is absent on
  // a pre-ingest read-only DB).
  const hasMeta = tableExists(db, "session_meta");
  const children = db
    .prepare(
      `SELECT s.id, s.ai_title, s.slug, s.turn_count, s.started_at, s.workflow_run_id,
              (SELECT GROUP_CONCAT(DISTINCT model) FROM token_usage t WHERE t.session_id = s.id) AS models
              ${hasMeta ? ", sm.agent_type, sm.agent_description, sm.spawn_depth" : ", NULL AS agent_type, NULL AS agent_description, NULL AS spawn_depth"}
       FROM sessions s ${hasMeta ? "LEFT JOIN session_meta sm ON sm.session_id = s.id" : ""}
       WHERE s.parent_session_id = ? ORDER BY s.started_at`,
    )
    .all(id) as any[];
  for (const ch of children) {
    ch.title = ch.ai_title || ch.slug || null;
    const u = db
      .prepare(
        `SELECT model, SUM(input_tokens) i, SUM(output_tokens) o,
                SUM(cache_creation_input_tokens) cw, SUM(cache_read_input_tokens) cr
         FROM token_usage WHERE session_id = ? GROUP BY model`,
      )
      .all(ch.id) as any[];
    ch.tokens = u.reduce((a, r) => a + r.i + r.o + r.cw + r.cr, 0);
    ch.cost = Number(
      u.reduce((a, r) => a + costForUsage(r.model, { input_tokens: r.i, output_tokens: r.o, cache_creation_input_tokens: r.cw, cache_read_input_tokens: r.cr }), 0).toFixed(4),
    );
  }

  // Workflow runs launched from THIS session: each Workflow tool_call carries a run id + name and sits
  // on a turn. This lets the UI group the spawned subagents by run and link each group back to the
  // exact launching turn (turn_seq) — instead of one flat, unattributed fan-out list.
  // Run status rides along from the result sidecar (workflow_results) when ingested, so the session's
  // workflow-run groups can flag a failed/completed run at a glance. NULL when no sidecar (async, still
  // pending) or the table isn't present yet (read-only pre-ingest DB).
  const hasWR = tableExists(db, "workflow_results");
  const workflow_runs = db
    .prepare(
      `SELECT tc.workflow_run_id AS run_id, tc.workflow_name AS name, t.seq AS turn_seq,
              (SELECT COUNT(*) FROM sessions s WHERE s.workflow_run_id = tc.workflow_run_id) AS agent_count
              ${hasWR ? ", (SELECT status FROM workflow_results wr WHERE wr.run_id = tc.workflow_run_id) AS status" : ", NULL AS status"}
       FROM tool_calls tc LEFT JOIN turns t ON t.id = tc.turn_id
       WHERE tc.session_id = ? AND tc.workflow_run_id IS NOT NULL
       ORDER BY t.seq`,
    )
    .all(id) as any[];

  // Tool-call error roll-up for the detail header. Computed from the already-fetched toolRows so no extra
  // query is needed. The raw error count is authoritative; the failure-vs-rejection split uses the stored
  // heuristic error_type (rejection = the user/guardrail declined the call, not an agent failure).
  session.tool_call_count = toolRows.length;
  session.tool_error_count = toolRows.filter((t) => t.status === "error").length;
  session.tool_rejection_count = toolRows.filter((t) => t.status === "error" && t.error_type && errorKind(t.error_type) === "rejection").length;
  session.tool_failure_count = session.tool_error_count - session.tool_rejection_count;

  return { session, turns, events, classification, parent, children, workflow_runs, findings: sessionFindings };
}

/**
 * A Workflow-tool run's detail: the launching tool_call (name, status, returned result) + the turn
 * and session it was launched from, every subagent session fanned out under its `workflow_run_id`,
 * and roll-up stats (agent count, tokens, cost, wall-clock span). Powers the /workflow/:run_id page.
 * Returns null when no Workflow tool_call carries this run id (→ 404).
 */
/** Pull the inner text of a single `<tag>…</tag>` from a flattened message (non-greedy). */
function xmlTag(text: string, tag: string): string | null {
  return text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? null;
}

/** Whether a table exists — the server opens the DB read-only, so a not-yet-ingested schema (no
 * workflow_results table) must degrade gracefully rather than throw. */
function tableExists(db: DB, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

/** Parse a stored JSON column back to a value, or null when absent/malformed. */
function safeJson(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function getWorkflow(db: DB, runId: string) {
  const wf = db
    .prepare(
      `SELECT tc.id AS tool_use_id, tc.workflow_run_id AS run_id, tc.workflow_name AS name, tc.status, tc.result_summary,
              tc.input_json AS input_json,
              tc.session_id AS parent_session_id, t.seq AS turn_seq,
              ps.ai_title AS parent_ai_title, ps.slug AS parent_slug
       FROM tool_calls tc
       LEFT JOIN turns t ON t.id = tc.turn_id
       LEFT JOIN sessions ps ON ps.id = tc.session_id
       WHERE tc.workflow_run_id = ? AND tc.tool_name = 'Workflow'
       ORDER BY t.seq
       LIMIT 1`,
    )
    .get(runId) as any;
  if (!wf) return null;

  // Subagent sessions in this run (same projection as getSession's children, plus the wall-clock
  // fields so the page can show each agent's span and a run-level min/max). LEFT JOIN session_meta for
  // the authoritative type/description/depth — these workflow agents carry none in-transcript.
  const hasMeta = tableExists(db, "session_meta");
  const agents = db
    .prepare(
      `SELECT s.id, s.ai_title, s.slug, s.turn_count, s.started_at, s.ended_at, s.duration_ms,
              (SELECT GROUP_CONCAT(DISTINCT model) FROM token_usage t WHERE t.session_id = s.id) AS models
              ${hasMeta ? ", sm.agent_type, sm.agent_description, sm.spawn_depth" : ", NULL AS agent_type, NULL AS agent_description, NULL AS spawn_depth"}
       FROM sessions s ${hasMeta ? "LEFT JOIN session_meta sm ON sm.session_id = s.id" : ""}
       WHERE s.workflow_run_id = ? ORDER BY s.started_at`,
    )
    .all(runId) as any[];

  let total_tokens = 0;
  let total_cost = 0;
  let started_at: string | null = null;
  let ended_at: string | null = null;
  for (const a of agents) {
    a.title = a.ai_title || a.slug || null;
    const u = db
      .prepare(
        `SELECT model, SUM(input_tokens) i, SUM(output_tokens) o,
                SUM(cache_creation_input_tokens) cw, SUM(cache_read_input_tokens) cr
         FROM token_usage WHERE session_id = ? GROUP BY model`,
      )
      .all(a.id) as any[];
    a.tokens = u.reduce((acc, r) => acc + r.i + r.o + r.cw + r.cr, 0);
    a.cost = Number(
      u.reduce((acc, r) => acc + costForUsage(r.model, { input_tokens: r.i, output_tokens: r.o, cache_creation_input_tokens: r.cw, cache_read_input_tokens: r.cr }), 0).toFixed(4),
    );
    total_tokens += a.tokens;
    total_cost += a.cost;
    if (a.started_at && (!started_at || a.started_at < started_at)) started_at = a.started_at;
    if (a.ended_at && (!ended_at || a.ended_at > ended_at)) ended_at = a.ended_at;
  }
  const duration_ms = started_at && ended_at ? new Date(ended_at).getTime() - new Date(started_at).getTime() : null;

  // The workflow's ACTUAL result arrives later as a `<task-notification>` user message in the
  // launching session — tc.result_summary is only the "launched in background" ack. Find that
  // message by the Workflow tool-use id and surface its completion status, summary, result, and
  // failures. (The same task can notify more than once; take the most recent.)
  let completion: { status: string | null; summary: string | null; result: string | null; failures: string | null } | null = null;
  if (wf.tool_use_id && wf.parent_session_id) {
    const ev = db
      .prepare(
        `SELECT raw_json FROM events
         WHERE session_id = ? AND text LIKE '%<task-notification>%' AND text LIKE ?
         ORDER BY timestamp DESC LIMIT 1`,
      )
      .get(wf.parent_session_id, `%${wf.tool_use_id}%`) as any;
    if (ev) {
      const { text } = extractParts(ev.raw_json);
      const t = text ?? "";
      completion = { status: xmlTag(t, "status"), summary: xmlTag(t, "summary"), result: xmlTag(t, "result"), failures: xmlTag(t, "failures") };
    }
  }

  // The runner's own result sidecar (workflow_results), ingested from wf_<id>.json. It's the
  // authoritative record of how the run finished — especially for async runs that never posted a
  // task-notification (completion above stays null) or that failed before fanning out any agents.
  // Sidecar-preferred: it supplies status + the returned result and fills the completion when the
  // transcript has none. Its self-reported roll-up (model, tokens, tool calls, phases, per-item logs,
  // duration, agent count) rides along as `run` so the page can show it even with zero ingested agents.
  const wr = tableExists(db, "workflow_results")
    ? (db
        .prepare(
          `SELECT status, summary, default_model, result_json, phases_json, logs_json, progress_json,
                  agent_count, total_tokens, total_tool_calls, duration_ms, started_at, ended_at
           FROM workflow_results WHERE run_id = ?`,
        )
        .get(wf.run_id) as any)
    : null;

  let run: {
    status: string | null;
    summary: string | null;
    default_model: string | null;
    agent_count: number | null;
    total_tokens: number | null;
    total_tool_calls: number | null;
    duration_ms: number | null;
    started_at: string | null;
    ended_at: string | null;
    phases: unknown;
    logs: unknown;
    progress: unknown;
  } | null = null;
  if (wr) {
    run = {
      status: wr.status ?? null,
      summary: wr.summary ?? null,
      default_model: wr.default_model ?? null,
      agent_count: wr.agent_count ?? null,
      total_tokens: wr.total_tokens ?? null,
      total_tool_calls: wr.total_tool_calls ?? null,
      duration_ms: wr.duration_ms ?? null,
      started_at: wr.started_at ?? null,
      ended_at: wr.ended_at ?? null,
      phases: safeJson(wr.phases_json),
      logs: safeJson(wr.logs_json),
      // The per-phase/per-agent event timeline (workflowProgress) — lets the page render a phase graph
      // with a per-phase descriptor (agent count, models). Absent on older/failed runs → UI falls back.
      progress: safeJson(wr.progress_json),
    };
    if (wr.result_json != null || wr.status) {
      completion = {
        status: wr.status ?? completion?.status ?? null,
        summary: wr.summary ?? completion?.summary ?? null,
        result: wr.result_json ?? completion?.result ?? null,
        failures: completion?.failures ?? null,
      };
    }
  }

  return {
    run_id: wf.run_id,
    name: wf.name ?? null,
    status: wr?.status ?? wf.status ?? null,
    result_summary: wf.result_summary ?? null,
    input_json: wf.input_json ?? null,
    completion,
    run,
    parent: { id: wf.parent_session_id, title: wf.parent_ai_title || wf.parent_slug || null, turn_seq: wf.turn_seq ?? null },
    agents,
    stats: { agent_count: agents.length, total_tokens, total_cost: Number(total_cost.toFixed(4)), started_at, ended_at, duration_ms },
  };
}

export interface SkillFilters {
  q?: string;
  source?: string;
  project?: string;
}

/**
 * One row per fired skill (grouped by name), for the Skills list. `version_count` is the number of
 * distinct captured content versions (COUNT(DISTINCT skill_id) ignores firings with no body), while
 * `call_count` counts every firing — so a skill whose body was never captured still appears. Filters
 * (name search, source, project) mirror the sessions list and apply to the firing session.
 */
export function listSkills(db: DB, f: SkillFilters = {}) {
  const where = ["tc.tool_name = 'Skill'", "tc.skill_name IS NOT NULL"];
  const params: any[] = [];
  // Search matches the skill name OR any captured version body, so a query for a phrase that only
  // appears inside a SKILL.md still surfaces the skill. (skills.body is the normalized body; joined by
  // name rather than skill_id so firings with no captured body still match on name.)
  if (f.q && f.q.trim()) {
    const like = `%${f.q.trim()}%`;
    where.push("(tc.skill_name LIKE ? OR EXISTS (SELECT 1 FROM skills sk WHERE sk.name = tc.skill_name AND sk.body LIKE ?))");
    params.push(like, like);
  }
  if (f.source) (where.push("s.source_id = ?"), params.push(f.source));
  if (f.project) (where.push("s.project_id = ?"), params.push(f.project));
  const rows = db
    .prepare(
      `SELECT tc.skill_name AS name,
              COUNT(*) AS call_count,
              COUNT(DISTINCT tc.skill_id) AS version_count,
              MAX(e.timestamp) AS last_fired,
              GROUP_CONCAT(DISTINCT s.source_id) AS sources
       FROM tool_calls tc
       JOIN sessions s ON s.id = tc.session_id
       LEFT JOIN events e ON e.uuid = tc.event_uuid
       WHERE ${where.join(" AND ")}
       GROUP BY tc.skill_name
       ORDER BY call_count DESC, name`,
    )
    .all(...params) as any[];
  for (const r of rows) r.sources = r.sources ? String(r.sources).split(",").filter(Boolean) : [];
  return rows;
}

/**
 * All data for one skill (by name): its content versions (most-recent first, each with body +
 * firing count) and the sessions that fired it, tagged with which version (`version_id`) so the UI
 * can map the session list to the selected version. Returns null (→ 404) when the name never fired.
 */
export function getSkill(db: DB, name: string) {
  const versions = db
    .prepare(
      `SELECT sk.id, sk.base_dir, sk.summary, sk.body, sk.body_bytes, sk.first_seen, sk.last_seen,
              (SELECT COUNT(*) FROM tool_calls tc WHERE tc.skill_id = sk.id) AS call_count
       FROM skills sk WHERE sk.name = ? ORDER BY sk.last_seen DESC, sk.id`,
    )
    .all(name) as any[];

  const sessions = db
    .prepare(
      `SELECT s.id, s.ai_title, s.slug, s.source_id, s.started_at, p.path AS project_path,
              tc.skill_id AS version_id, MIN(e.timestamp) AS fired_at, COUNT(*) AS fire_count
       FROM tool_calls tc
       JOIN sessions s ON s.id = tc.session_id
       LEFT JOIN projects p ON p.id = s.project_id
       LEFT JOIN events e ON e.uuid = tc.event_uuid
       WHERE tc.tool_name = 'Skill' AND tc.skill_name = ?
       GROUP BY s.id, tc.skill_id
       ORDER BY fired_at DESC`,
    )
    .all(name) as any[];

  if (!versions.length && !sessions.length) return null;
  for (const s of sessions) s.title = s.ai_title || s.slug || null;
  const call_count = sessions.reduce((a, s) => a + (s.fire_count as number), 0);
  return { name, versions, sessions, call_count };
}

// ---- Security findings (ADR-017) + triage (ADR-018) ----------------------

export interface FindingFilters {
  severity?: string;
  category?: string;
  rule?: string;
  session?: string;
  source?: string;
  project?: string;
  from?: string;
  to?: string;
  /** open (default; excludes dismissed + muted) | dismissed | muted | all. */
  status?: "open" | "dismissed" | "muted" | "all";
  /** Sort the whole filtered list before pagination. Defaults to "severity" (most-severe first). */
  sort?: "severity" | "session" | "rule" | "category" | "time";
  dir?: "asc" | "desc";
  limit: number;
  offset: number;
}

// Rank severities inside SQL so the list can be severity-ordered and paginated without materializing
// everything (mirrors SEVERITY_ORDER in core: info=1 … critical=5).
const SEVERITY_RANK_SQL =
  "CASE f.severity WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 WHEN 'info' THEN 1 ELSE 0 END";

// A finding is muted when a muted_rules row matches its rule at global/project/source scope. Only valid
// when the triage DB is ATTACHed (createApp does this); guarded by triageAttached() everywhere it's used.
const MUTED_SQL = `EXISTS (SELECT 1 FROM triage.muted_rules m WHERE m.rule_id = f.rule_id
   AND (m.scope='global' OR (m.scope='project' AND m.scope_id = s.project_id) OR (m.scope='source' AND m.scope_id = s.source_id)))`;

/** Whether the writable triage store is ATTACHed to this (read) connection — gates all triage SQL. */
export function triageAttached(db: DB): boolean {
  return (db.prepare("PRAGMA database_list").all() as Array<{ name: string }>).some((r) => r.name === "triage");
}

/** WHERE fragments shared by list + summary: user filters (no status) over findings f / sessions s. */
function findingWhere(f: FindingFilters): { sql: string[]; params: any[] } {
  const sql: string[] = [];
  const params: any[] = [];
  if (f.severity) (sql.push("f.severity = ?"), params.push(f.severity));
  if (f.category) (sql.push("f.category = ?"), params.push(f.category));
  if (f.rule) (sql.push("f.rule_id = ?"), params.push(f.rule));
  if (f.session) (sql.push("f.session_id = ?"), params.push(f.session));
  if (f.source) (sql.push("s.source_id = ?"), params.push(f.source));
  if (f.project) (sql.push("s.project_id = ?"), params.push(f.project));
  // Compare on the DATE part so a picked day is inclusive on both ends — `to = 2026-07-14` must include
  // 2026-07-14 events (a plain `started_at <= '2026-07-14'` would exclude that whole day's timestamps).
  if (f.from) (sql.push("date(s.started_at) >= date(?)"), params.push(f.from));
  if (f.to) (sql.push("date(s.started_at) <= date(?)"), params.push(f.to));
  return { sql, params };
}

/** Status → WHERE fragment over the dismissed LEFT JOIN (`d`) + MUTED_SQL. Empty when triage absent. */
function statusWhere(status: FindingFilters["status"], attached: boolean): string {
  if (!attached) return status === "dismissed" || status === "muted" ? "1 = 0" : ""; // no triage → nothing dismissed/muted
  switch (status) {
    case "dismissed":
      return "d.finding_id IS NOT NULL";
    case "muted":
      return `d.finding_id IS NULL AND ${MUTED_SQL}`;
    case "all":
      return "";
    default: // open
      return `d.finding_id IS NULL AND NOT ${MUTED_SQL}`;
  }
}

/**
 * The browsable findings list (GET /api/security/findings), filtered/sorted/paged. Each row carries
 * enough session context (title, project, source, when) to render and link without a second fetch, plus
 * its triage state (dismissed flag/note/when) when the triage store is attached. Default status hides
 * dismissed + muted so real, un-triaged findings surface. Guarded for a pre-ingest read-only DB.
 */
export function listFindings(db: DB, f: FindingFilters) {
  if (!tableExists(db, "findings")) return { total: 0, findings: [] };
  const attached = triageAttached(db);

  const w = findingWhere(f);
  const st = statusWhere(f.status ?? "open", attached);
  const where = [...w.sql, ...(st ? [st] : [])];
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const dismissJoin = attached ? "LEFT JOIN triage.dismissed_findings d ON d.finding_id = f.id" : "";
  const triageCols = attached
    ? `, (d.finding_id IS NOT NULL) AS dismissed, d.note AS dismiss_note, d.dismissed_at, ${MUTED_SQL} AS muted`
    : `, 0 AS dismissed, NULL AS dismiss_note, NULL AS dismissed_at, 0 AS muted`;

  const total = (
    db
      .prepare(`SELECT COUNT(*) n FROM findings f JOIN sessions s ON s.id = f.session_id ${dismissJoin} ${whereSql}`)
      .get(...w.params) as any
  ).n;

  const ORDER: Record<string, string> = {
    severity: SEVERITY_RANK_SQL,
    session: "f.session_id",
    rule: "f.rule_id",
    category: "f.category",
    time: "s.started_at",
  };
  const orderCol = ORDER[f.sort ?? "severity"] ?? SEVERITY_RANK_SQL;
  const dir = f.dir === "asc" ? "ASC" : "DESC";

  const findings = db
    .prepare(
      `SELECT f.id, f.session_id, f.tool_call_id, f.event_uuid, f.turn_id, f.rule_id, f.category,
              f.framework_ref, f.severity, f.title, f.evidence, tc.tool_name,
              COALESCE(s.ai_title, s.slug) AS session_title, s.source_id, s.is_sidechain,
              s.started_at, p.path AS project_path, s.project_id ${triageCols}
       FROM findings f
       JOIN sessions s ON s.id = f.session_id
       LEFT JOIN projects p ON p.id = s.project_id
       LEFT JOIN tool_calls tc ON tc.id = f.tool_call_id
       ${dismissJoin}
       ${whereSql}
       ORDER BY ${orderCol} ${dir}, ${SEVERITY_RANK_SQL} DESC, f.id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...w.params, f.limit, f.offset);

  return { total, findings };
}

/**
 * Roll-up for the /security page header + the Dashboard KPI. Counts (by severity/category/rule,
 * sessions flagged) are computed over **open** findings — dismissed + muted excluded — so the KPIs show
 * what still needs review; `dismissed` and `muted` totals ride along for the triage affordances. The
 * framework reference content (core) powers the "what & why" explainers. Guarded for a pre-ingest DB.
 */
export function securitySummary(db: DB) {
  const categories = SECURITY_CATEGORIES;
  if (!tableExists(db, "findings")) {
    return { total: 0, sessions_flagged: 0, dismissed: 0, muted: 0, by_severity: [], by_category: [], by_rule: [], categories };
  }
  const attached = triageAttached(db);
  const dismissJoin = attached ? "LEFT JOIN triage.dismissed_findings d ON d.finding_id = f.id" : "";
  const base = `FROM findings f JOIN sessions s ON s.id = f.session_id ${dismissJoin}`;
  const openWhere = attached ? `WHERE d.finding_id IS NULL AND NOT ${MUTED_SQL}` : "";

  const scalar = (sql: string) => (db.prepare(sql).get() as any).n as number;
  const total = scalar(`SELECT COUNT(*) n ${base} ${openWhere}`);
  const sessions_flagged = scalar(`SELECT COUNT(DISTINCT f.session_id) n ${base} ${openWhere}`);
  const dismissed = attached ? scalar(`SELECT COUNT(*) n FROM findings f LEFT JOIN triage.dismissed_findings d ON d.finding_id = f.id WHERE d.finding_id IS NOT NULL`) : 0;
  const muted = attached ? scalar(`SELECT COUNT(*) n ${base} WHERE d.finding_id IS NULL AND ${MUTED_SQL}`) : 0;

  const by_severity = db.prepare(`SELECT f.severity AS severity, COUNT(*) n ${base} ${openWhere} GROUP BY f.severity ORDER BY ${SEVERITY_RANK_SQL} DESC`).all();
  const by_category = db.prepare(`SELECT f.category AS category, COUNT(*) n ${base} ${openWhere} GROUP BY f.category ORDER BY n DESC`).all();
  const by_rule = db
    .prepare(
      `SELECT f.rule_id AS rule_id, f.category AS category, f.title AS title, COUNT(*) n, MAX(${SEVERITY_RANK_SQL}) AS rank
       ${base} ${openWhere} GROUP BY f.rule_id ORDER BY rank DESC, n DESC`,
    )
    .all();
  return { total, sessions_flagged, dismissed, muted, by_severity, by_category, by_rule, categories };
}
