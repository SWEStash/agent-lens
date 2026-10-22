/** A Workflow-tool run's detail page (GET /api/workflows/:run_id). */
import { TASK_FAILURES_TAG, TASK_NOTIFICATION_TAG, TASK_RESULT_TAG, TASK_STATUS_TAG, TASK_SUMMARY_TAG, xmlTag } from "@agent-lens/transcript-format";
import type { WorkflowAgent, WorkflowCompletion, WorkflowDetail, WorkflowRunResult } from "@agent-lens/contracts";
import { tableExists, queryAll, queryGet, metaJoin, metaProjection } from "../sql-util.js";
import type { WorkflowAgentRow, WorkflowLaunchRow, WorkflowResultRow } from "../rows.js";
import { usageBySession, splitOf, tokensOf, costOf } from "../usage.js";
import { type DB, SESSION_MODELS_SQL, displayTitle, safeJson } from "./common.js";

/** Subagent sessions in this run (same projection as getSession's children, plus the wall-clock fields
 * so the page can show each agent's span and a run-level min/max), with the run's token/cost/span
 * roll-up computed over them. LEFT JOIN session_meta for the authoritative type/description/depth —
 * these workflow agents carry none in-transcript. */
function loadAgents(db: DB, runId: string): { agents: WorkflowAgent[]; stats: WorkflowDetail["stats"] } {
  const hasMeta = tableExists(db, "session_meta");
  const agentRows = queryAll<WorkflowAgentRow>(
    db,
    `SELECT s.id, s.ai_title, s.slug, s.turn_count, s.started_at, s.ended_at, s.duration_ms,
            ${SESSION_MODELS_SQL}
            ${metaProjection(hasMeta)}
     FROM sessions s ${metaJoin(hasMeta)}
     WHERE s.workflow_run_id = ? ORDER BY s.started_at`,
    runId,
  );

  let total_tokens = 0;
  let total_cost = 0;
  let started_at: string | null = null;
  let ended_at: string | null = null;
  const usage = usageBySession(db, agentRows.map((r) => r.id));
  const agents: WorkflowAgent[] = agentRows.map(({ ai_title, slug, ...r }) => {
    const u = usage.get(r.id) ?? [];
    const a = { ...r, title: displayTitle(ai_title, slug), tokens: tokensOf(splitOf(u)), cost: costOf(u) };
    total_tokens += a.tokens;
    total_cost += a.cost;
    if (a.started_at && (!started_at || a.started_at < started_at)) started_at = a.started_at;
    if (a.ended_at && (!ended_at || a.ended_at > ended_at)) ended_at = a.ended_at;
    return a;
  });
  const duration_ms = started_at && ended_at ? new Date(ended_at).getTime() - new Date(started_at).getTime() : null;

  return {
    agents,
    stats: { agent_count: agents.length, total_tokens, total_cost: Number(total_cost.toFixed(4)), started_at, ended_at, duration_ms },
  };
}

/** The workflow's ACTUAL result, which arrives later as a `<task-notification>` user message in the
 * launching session — tc.result_summary is only the "launched in background" ack. Finds that message by
 * the Workflow tool-use id and surfaces its completion status, summary, result, and failures. (The same
 * task can notify more than once; takes the most recent.) */
function parseCompletion(db: DB, wf: WorkflowLaunchRow): WorkflowCompletion | null {
  if (!wf.tool_use_id || !wf.parent_session_id) return null;
  const ev = queryGet<{ text: string | null }>(
    db,
    `SELECT text FROM events
     WHERE session_id = ? AND text LIKE '%<${TASK_NOTIFICATION_TAG}>%' AND text LIKE ?
     ORDER BY timestamp DESC LIMIT 1`,
    wf.parent_session_id,
    `%${wf.tool_use_id}%`,
  );
  if (!ev) return null;
  const t = ev.text ?? "";
  return {
    status: xmlTag(t, TASK_STATUS_TAG),
    summary: xmlTag(t, TASK_SUMMARY_TAG),
    result: xmlTag(t, TASK_RESULT_TAG),
    failures: xmlTag(t, TASK_FAILURES_TAG),
  };
}

/** The runner's own result sidecar (workflow_results), ingested from wf_<id>.json. It's the
 * authoritative record of how the run finished — especially for async runs that never posted a
 * task-notification (`completion` stays null) or that failed before fanning out any agents.
 * Sidecar-preferred: it supplies status + the returned result and fills the completion when the
 * transcript has none. Its self-reported roll-up (model, tokens, tool calls, phases, per-item logs,
 * duration, agent count) rides along as `run` so the page can show it even with zero ingested agents. */
function loadRunSidecar(
  db: DB,
  runId: string,
  completion: WorkflowCompletion | null,
): { wr: WorkflowResultRow | null; run: WorkflowRunResult | null; completion: WorkflowCompletion | null } {
  const wr = tableExists(db, "workflow_results")
    ? (queryGet<WorkflowResultRow>(
        db,
        `SELECT status, summary, default_model, result_json, phases_json, logs_json, progress_json,
                agent_count, total_tokens, total_tool_calls, duration_ms, started_at, ended_at
         FROM workflow_results WHERE run_id = ?`,
        runId,
      ) ?? null)
    : null;
  if (!wr) return { wr: null, run: null, completion };

  const run: WorkflowRunResult = {
    status: wr.status ?? null,
    summary: wr.summary ?? null,
    default_model: wr.default_model ?? null,
    agent_count: wr.agent_count ?? null,
    total_tokens: wr.total_tokens ?? null,
    total_tool_calls: wr.total_tool_calls ?? null,
    duration_ms: wr.duration_ms ?? null,
    started_at: wr.started_at ?? null,
    ended_at: wr.ended_at ?? null,
    // The three JSON blobs are asserted, not validated (ADR-026): safeJson yields null for malformed
    // stored text, and these casts are what claims the shape of everything else.
    phases: safeJson(wr.phases_json) as WorkflowRunResult["phases"],
    logs: safeJson(wr.logs_json) as WorkflowRunResult["logs"],
    // The per-phase/per-agent event timeline (workflowProgress) — lets the page render a phase graph
    // with a per-phase descriptor (agent count, models). Absent on older/failed runs → UI falls back.
    progress: safeJson(wr.progress_json) as WorkflowRunResult["progress"],
  };

  if (wr.result_json != null || wr.status) {
    completion = {
      status: wr.status ?? completion?.status ?? null,
      summary: wr.summary ?? completion?.summary ?? null,
      result: wr.result_json ?? completion?.result ?? null,
      failures: completion?.failures ?? null,
    };
  }
  return { wr, run, completion };
}

/**
 * A Workflow-tool run's detail: the launching tool_call (name, status, returned result) + the turn
 * and session it was launched from, every subagent session fanned out under its `workflow_run_id`,
 * and roll-up stats (agent count, tokens, cost, wall-clock span). Powers the /workflow/:run_id page.
 * Returns null when no Workflow tool_call carries this run id (→ 404).
 */
export function getWorkflow(db: DB, runId: string): WorkflowDetail | null {
  const wf = queryGet<WorkflowLaunchRow>(
    db,
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
    runId,
  );
  if (!wf) return null;

  const { agents, stats } = loadAgents(db, runId);
  const { wr, run, completion } = loadRunSidecar(db, wf.run_id, parseCompletion(db, wf));

  return {
    run_id: wf.run_id,
    name: wf.name ?? null,
    status: wr?.status ?? wf.status ?? null,
    result_summary: wf.result_summary ?? null,
    input_json: wf.input_json ?? null,
    completion,
    run,
    parent: { id: wf.parent_session_id, title: displayTitle(wf.parent_ai_title, wf.parent_slug), turn_seq: wf.turn_seq ?? null },
    agents,
    stats,
  };
}
