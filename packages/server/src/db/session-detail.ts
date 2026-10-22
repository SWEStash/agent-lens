/** One session's detail payload (GET /api/sessions/:id) and its archive location. */
import { existsSync } from "node:fs";
import { severityRank, errorKind, type ToolErrorType } from "@agent-lens/core";
import type { Finding, FileChangeRow, EventNode, Classification, ClassificationSignals, SessionChild, SessionDetail, SessionDetailData, SessionLocation, SessionParent, SessionRow, TokenSplit, ToolCall, TurnRow, WorkflowRun } from "@agent-lens/contracts";
import { tableExists, queryAll, queryGet, pushGrouped, metaJoin, metaProjection } from "../sql-util.js";
import type { ToolCallProjection, ClassificationProjectionRow, EventProjectionRow, EventUsageRow, FindingProjectionRow, SessionChildRow, SessionParentRow, ToolResultRow } from "../rows.js";
import { sessionUsage, usageBySession, splitOf, tokensOf, costOf, unpricedOf } from "../usage.js";
import { type DB, SESSION_MODELS_SQL, displayTitle, safeJson } from "./common.js";

/** The session's tool calls, with any spilled full output attached.
 *
 * When a result_summary is the "Full output saved to: …/tool-results/<name>.txt" marker (the
 * transcript's 280-char stand-in), the un-truncated text is pulled from tool_results so the UI can
 * expand it. Keyed by (session_id, name); guarded for a pre-ingest DB. */
function loadToolCalls(db: DB, id: string): ToolCallProjection[] {
  const toolRows = queryAll<ToolCallProjection>(
    db,
    `SELECT id, event_uuid, tool_name, skill_name, skill_id, agent_type, spawned_session_id,
            workflow_run_id, workflow_name, status, error_type,
            total_duration_ms, input_json, result_summary,
            (SELECT COUNT(*) FROM sessions s WHERE s.workflow_run_id = tool_calls.workflow_run_id) AS workflow_agent_count
     FROM tool_calls WHERE session_id = ?`,
    id,
  );

  if (tableExists(db, "tool_results")) {
    const getFull = db.prepare("SELECT text, bytes FROM tool_results WHERE session_id = ? AND name = ?");
    for (const t of toolRows) {
      const m = typeof t.result_summary === "string" ? t.result_summary.match(/tool-results\/([A-Za-z0-9_-]+)\.txt/) : null;
      if (!m) continue;
      const full = getFull.get(id, m[1]) as ToolResultRow | undefined;
      if (full) t.full_result = { text: full.text, bytes: full.bytes };
    }
  }
  return toolRows;
}

/** Security findings (ADR-017): attaches each tool call's findings inline (for the transcript severity
 * badge + "why" panel) and returns the session-level list for the header summary, most-severe first.
 * Guarded for a read-only pre-ingest DB whose schema predates the findings table. */
function loadFindings(db: DB, id: string, toolRows: ToolCallProjection[]): Finding[] {
  if (!tableExists(db, "findings")) return [];
  const sessionFindings: Finding[] = [];
  const findingRows = queryAll<FindingProjectionRow>(
    db,
    `SELECT id, tool_call_id, event_uuid, turn_id, rule_id, category, framework_ref, severity, title, evidence, signals_json
     FROM findings WHERE session_id = ?`,
    id,
  );
  const byToolCall = new Map<string, Finding[]>();
  for (const fr of findingRows) {
    const f: Finding = {
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
      // Asserted, not validated: safeJson returns unknown and this is the assertion (ADR-026).
      signals: safeJson(fr.signals_json) as Finding["signals"],
    };
    sessionFindings.push(f);
    if (fr.tool_call_id) pushGrouped(byToolCall, fr.tool_call_id, f);
  }
  for (const t of toolRows) t.findings = t.id ? (byToolCall.get(t.id) ?? []) : [];
  // Most-severe first so a session banner can lead with the worst.
  sessionFindings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  return sessionFindings;
}

/** Drop the columns the query needed but the response does not ship (ADR-026): `event_uuid` has just
 *  been used to nest this call under its event, and `error_type` feeds the server-side
 *  failure-vs-rejection split and reaches the UI only as a dashboard breakdown. */
function toResponseToolCall({ event_uuid: _e, error_type: _t, ...call }: ToolCallProjection): ToolCall {
  return call;
}

/** Does this event put anything on screen? Mirrors EventBlock's body check on the web side. */
function rendersSomething(e: EventProjectionRow, toolsByEvent: Map<string, ToolCallProjection[]>): boolean {
  return !!(e.text || e.thinking || toolsByEvent.get(e.uuid)?.length);
}

function addSplit(a: TokenSplit | null, b: TokenSplit | undefined): TokenSplit | null {
  if (!b) return a;
  if (!a) return { ...b };
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cache_creation: a.cache_creation + b.cache_creation,
    cache_read: a.cache_read + b.cache_read,
  };
}

/**
 * Attribute each usage row to the event a reader can actually see (ADR-032).
 *
 * A response's `token_usage` row is anchored to a transcript line that renders nothing, so this walks
 * each turn in `seq` order, carries usage forward from the non-rendering events, and attaches the
 * accumulated total to the next event that renders. Trailing usage folds back onto the turn's last
 * rendering event. Usage never crosses a turn boundary.
 */
function foldUsage(
  eventRows: EventProjectionRow[],
  toolsByEvent: Map<string, ToolCallProjection[]>,
  usageByEvent: Map<string, TokenSplit>,
): Map<string, TokenSplit> {
  const out = new Map<string, TokenSplit>();
  if (usageByEvent.size === 0) return out;

  const byTurn = new Map<string, EventProjectionRow[]>();
  for (const e of eventRows) pushGrouped(byTurn, e.turn_id ?? "", e);

  for (const group of byTurn.values()) {
    const ordered = [...group].sort((a, b) => a.seq - b.seq);
    let pending: TokenSplit | null = null;
    let lastRendering: string | null = null;
    for (const e of ordered) {
      const own = usageByEvent.get(e.uuid);
      if (rendersSomething(e, toolsByEvent)) {
        const total = addSplit(pending, own);
        if (total) out.set(e.uuid, total);
        pending = null;
        lastRendering = e.uuid;
      } else {
        pending = addSplit(pending, own);
      }
    }
    // Trailing usage with no rendering event after it: fold back onto the last one there was.
    if (pending && lastRendering) out.set(lastRendering, addSplit(out.get(lastRendering) ?? null, pending)!);
  }
  return out;
}

/** The session's transcript events in order, each with its flattened text/thinking and its tool calls. */
function loadEvents(db: DB, id: string, toolRows: ToolCallProjection[]): EventNode[] {
  const eventRows = queryAll<EventProjectionRow>(
    db,
    `SELECT uuid, seq, type, role, timestamp, model, is_sidechain, turn_id, text, thinking
     FROM events WHERE session_id = ? ORDER BY timestamp, seq`,
    id,
  );

  const toolsByEvent = new Map<string, ToolCallProjection[]>();
  for (const t of toolRows) {
    if (!t.event_uuid) continue;
    pushGrouped(toolsByEvent, t.event_uuid, t);
  }

  // Per-event usage in ONE query for the session, mapped in memory — the alternative, a lookup per
  // event, is a query per message on a 1 600-event transcript.
  const usageByEvent = new Map<string, TokenSplit>();
  for (const u of queryAll<EventUsageRow>(
    db,
    `SELECT event_uuid, input_tokens i, output_tokens o, cache_creation_input_tokens cw,
            cache_read_input_tokens cr
     FROM token_usage WHERE session_id = ?`,
    id,
  )) {
    usageByEvent.set(u.event_uuid, { input: u.i, output: u.o, cache_creation: u.cw, cache_read: u.cr });
  }
  const folded = foldUsage(eventRows, toolsByEvent, usageByEvent);

  return eventRows.map((e) => {
    const usage = folded.get(e.uuid);
    return {
      uuid: e.uuid,
      type: e.type,
      role: e.role,
      timestamp: e.timestamp,
      model: e.model,
      is_sidechain: e.is_sidechain,
      turn_id: e.turn_id,
      text: e.text,
      thinking: e.thinking,
      toolCalls: (toolsByEvent.get(e.uuid) ?? []).map(toResponseToolCall),
      // Spread so the key is ABSENT, not null, on the majority of events that carry no usage row.
      ...(usage ? { usage } : {}),
    };
  });
}

/** Heuristic classification: category + complexity + the signals that produced them
 * (tool/skill mix, LoC, files, subagent count) — already captured in signals_json by the classifier. */
function loadClassification(db: DB, id: string): Classification | null {
  const cls = queryGet<ClassificationProjectionRow>(
    db,
    `SELECT category, complexity_score, complexity_band, signals_json, classifier_version
     FROM classifications WHERE scope = 'session' AND target_id = ?`,
    id,
  );
  if (!cls) return null;
  // Asserted, not validated (ADR-026) — a malformed blob degrades to null, a well-formed one of the
  // wrong shape reaches the UI as declared.
  const signals = safeJson(cls.signals_json) as ClassificationSignals | null;
  return {
    category: cls.category,
    complexity_score: cls.complexity_score,
    complexity_band: cls.complexity_band,
    classifier_version: cls.classifier_version,
    signals,
  };
}

/** Subagent linkage (schema v3): if this is a sidechain session, resolve the parent turn/session that
 * spawned it so the UI can offer a "spawned by" crumb back to the originating turn. */
function loadParent(db: DB, session: SessionRow): SessionParent | null {
  if (!session.parent_session_id) return null;
  const p = queryGet<SessionParentRow>(
    db,
    `SELECT ps.id, ps.ai_title, ps.slug, t.seq AS turn_seq
     FROM sessions ps LEFT JOIN turns t ON t.id = ?
     WHERE ps.id = ?`,
    session.parent_turn_id,
    session.parent_session_id,
  );
  return p ? { id: p.id, title: displayTitle(p.ai_title, p.slug), turn_seq: p.turn_seq ?? null } : null;
}

/** Spawned subagents (schema v3): sessions whose parent_session_id points back here. Nesting them
 * under the parent is why the flat session list defaults to main-only — a task with N subagents is
 * one row with N children, not N+1 sibling rows sharing the same slug.
 * Subagent metadata sidecars (session_meta) supply the authoritative agentType/description/spawnDepth
 * — LEFT JOIN so a subagent still lists when its meta hasn't been ingested (or the table is absent on
 * a pre-ingest read-only DB). */
function loadChildren(db: DB, id: string): SessionChild[] {
  const hasMeta = tableExists(db, "session_meta");
  const children = queryAll<SessionChildRow>(
    db,
    `SELECT s.id, s.ai_title, s.slug, s.turn_count, s.started_at, s.workflow_run_id,
            ${SESSION_MODELS_SQL}
            ${metaProjection(hasMeta)}
     FROM sessions s ${metaJoin(hasMeta)}
     WHERE s.parent_session_id = ? ORDER BY s.started_at`,
    id,
  );
  const usage = usageBySession(db, children.map((ch) => ch.id));
  return children.map(({ ai_title, slug, ...ch }) => {
    const u = usage.get(ch.id) ?? [];
    return { ...ch, title: displayTitle(ai_title, slug), tokens: tokensOf(splitOf(u)), cost: costOf(u) };
  });
}

/** Workflow runs launched from THIS session: each Workflow tool_call carries a run id + name and sits
 * on a turn. This lets the UI group the spawned subagents by run and link each group back to the
 * exact launching turn (turn_seq) — instead of one flat, unattributed fan-out list.
 * Run status rides along from the result sidecar (workflow_results) when ingested, so the session's
 * workflow-run groups can flag a failed/completed run at a glance. NULL when no sidecar (async, still
 * pending) or the table isn't present yet (read-only pre-ingest DB). */
function loadWorkflowRuns(db: DB, id: string): WorkflowRun[] {
  const hasWR = tableExists(db, "workflow_results");
  return queryAll<WorkflowRun>(
    db,
    `SELECT tc.workflow_run_id AS run_id, tc.workflow_name AS name, t.seq AS turn_seq,
            (SELECT COUNT(*) FROM sessions s WHERE s.workflow_run_id = tc.workflow_run_id) AS agent_count
            ${hasWR ? ", (SELECT status FROM workflow_results wr WHERE wr.run_id = tc.workflow_run_id) AS status" : ", NULL AS status"}
     FROM tool_calls tc LEFT JOIN turns t ON t.id = tc.turn_id
     WHERE tc.session_id = ? AND tc.workflow_run_id IS NOT NULL
     ORDER BY t.seq`,
    id,
  );
}

/** File-modification provenance (ADR-022): the session's derived file changes (Edit/Write/
 * NotebookEdit calls and Bash shell writes), for the "Files changed" header roll-up. Guarded for a pre-v14 read-only DB. */
function loadFileChanges(db: DB, id: string): FileChangeRow[] {
  if (!tableExists(db, "file_changes")) return [];
  return queryAll<FileChangeRow>(
    db,
    `SELECT fc.id, fc.tool_call_id, fc.turn_id, fc.event_uuid, fc.file_path, fc.tool_name,
            fc.lines_added, fc.lines_removed, fc.timestamp
     FROM file_changes fc WHERE fc.session_id = ? ORDER BY fc.timestamp`,
    id,
  );
}

/** Roll-ups written onto the session row for the detail header: token split + cost, display title, and
 * the tool-call error counts (computed from the already-fetched toolRows, so no extra query).
 *
 * Tokens keep their categories split so the UI can show input/output/cache-write/cache-read separately.
 * Cache stays IN the total and IS cost-attributed (at its discounted rate) — differentiated, never
 * dropped. The raw error count is authoritative; the failure-vs-rejection split uses the stored
 * heuristic error_type (rejection = the user/guardrail declined the call, not an agent failure). */
function withSessionTotals(
  db: DB,
  session: SessionRow & { project_path: string | null },
  id: string,
  toolRows: ToolCallProjection[],
): SessionDetailData {
  const usage = sessionUsage(db, id);
  const split = splitOf(usage);

  const tool_error_count = toolRows.filter((t) => t.status === "error").length;
  // `error_type` is a plain column read, so nothing proves it is still one of core's ToolErrorType
  // literals — an older DB could hold a bucket name that has since been renamed. errorKind is a set
  // membership test that answers "failure" for anything unrecognized, so the cast is safe rather than
  // merely convenient; it replaces an `any` that was making the same assumption invisibly.
  const tool_rejection_count = toolRows.filter(
    (t) => t.status === "error" && t.error_type && errorKind(t.error_type as ToolErrorType) === "rejection",
  ).length;

  return {
    ...session,
    tokens: tokensOf(split),
    token_split: split,
    cost: costOf(usage),
    unpriced_models: unpricedOf(usage),
    title: displayTitle(session.ai_title, session.slug),
    tool_call_count: toolRows.length,
    tool_error_count,
    tool_rejection_count,
    tool_failure_count: tool_error_count - tool_rejection_count,
  };
}

export function getSession(db: DB, id: string): SessionDetail | null {
  const session = queryGet<SessionRow & { project_path: string | null }>(
    db,
    `SELECT s.*, p.path AS project_path FROM sessions s
     LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = ?`,
    id,
  );
  if (!session) return null;

  const turns = queryAll<TurnRow>(db, "SELECT * FROM turns WHERE session_id = ? ORDER BY seq", id);
  const toolRows = loadToolCalls(db, id);
  const findings = loadFindings(db, id, toolRows);
  const events = loadEvents(db, id, toolRows);

  return {
    session: withSessionTotals(db, session, id, toolRows),
    turns,
    events,
    classification: loadClassification(db, id),
    parent: loadParent(db, session),
    children: loadChildren(db, id),
    workflow_runs: loadWorkflowRuns(db, id),
    findings,
    file_changes: loadFileChanges(db, id),
  };
}

/**
 * Where session `id`'s transcript sits in the archive, for handing the file to another local agent.
 *
 * There is no path column on `sessions` — the archive path is recorded per event as
 * `events.source_file` (schema.ts), so the canonical file is picked from what ingest saw. A session
 * can have several: retention snapshots under `.versions/`, and (for a parent) its subagents' files
 * are separate sessions entirely. Prefer the live copy named after the session, then any live copy,
 * then whatever there is.
 *
 * Returns null when no event carries a source_file (nothing to point at).
 */
export function sessionLocation(db: DB, id: string): SessionLocation | null {
  const session = queryGet<{ source_id: string | null }>(db, "SELECT source_id FROM sessions WHERE id = ?", id);
  if (!session) return null;
  const files = queryAll<{ source_file: string }>(
    db,
    "SELECT DISTINCT source_file FROM events WHERE session_id = ? AND source_file IS NOT NULL",
    id,
  ).map((r) => r.source_file);
  if (files.length === 0) return null;

  const live = files.filter((f) => !f.includes("/.versions/"));
  const path = live.find((f) => f.endsWith(`/${id}.jsonl`)) ?? live[0] ?? files[0];
  // Reported, not enforced: the file may have been pruned by retention since ingest, and the caller
  // should be told that rather than handed a path that silently isn't there.
  return { session_id: id, path, exists: existsSync(path), source_id: session.source_id };
}
