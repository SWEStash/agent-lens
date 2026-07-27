/**
 * Agent Lens — Stage 2 ingest of Workflow-tool result sidecars.
 *
 * The Workflow tool writes a JSON sidecar next to the launching session when a run finishes:
 *   <archive>/<source>/projects/<enc>/<sessionId>/workflows/wf_<id>.json
 * The transcript only carries the "launched in background" ack for an async run, so for those runs
 * this file is the ONLY record of how the run finished — status (completed/failed), summary, the
 * returned result payload, the model, phase structure, per-item logs, and roll-up
 * tokens/tool-calls/duration/agent-count. We project those fields into `workflow_results` (verbatim,
 * like tool_calls.input_json — the DB is local; redaction is an export concern). The big `script` and
 * `args` are intentionally NOT re-stored: they already live on the launching Workflow tool_call.
 *
 * Idempotent: keyed by run id, UPSERT on re-ingest. The discover/skip/state machinery is shared with
 * the other sidecar ingesters in `sidecar.ts`; only the parse + upsert below is workflow-specific.
 */
import { basename } from "node:path";
import type { DB } from "./db.js";
import { ingestSidecars, newSidecarStats, sessionBefore, intOrNull, strOrNull, type SidecarStats } from "./sidecar.js";

export type WorkflowIngestStats = SidecarStats;
export const newWorkflowStats = newSidecarStats;

/** Epoch-ms number or ISO/date string → ISO string (null when unparseable/absent). */
function toIso(x: unknown): string | null {
  if (typeof x === "number" && Number.isFinite(x)) return new Date(x).toISOString();
  if (typeof x === "string" && x) {
    const t = Date.parse(x);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

const jsonOrNull = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

/** Strip terminal styling the runner sometimes bakes into defaultModel — both real ANSI escapes
 * (`\x1b[1m`) and the de-escaped literal form (`claude-opus-4-8[1m]`) — so the stored model is clean. */
function cleanStr(v: unknown): string | null {
  const s = strOrNull(v);
  if (!s) return null;
  return s
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "") // real ANSI escape sequences
    .replace(/\[[0-9;]+m\]?/g, "") // de-escaped leftovers: "[1m", "[1m]"
    .trim() || null;
}

/**
 * Ingest all workflow result sidecars for one source into `workflow_results`. `excludedDirs` are the
 * parsed exclude tokens (same filter the transcript walk uses). Returns nothing; mutates `stats`.
 */
export function ingestWorkflowResults(
  db: DB,
  sourceArchiveDir: string,
  sourceId: string,
  excludedDirs: string[],
  now: string,
  stats: WorkflowIngestStats,
  full: boolean,
): void {
  const upsert = db.prepare(
    `INSERT INTO workflow_results
       (run_id, source_id, session_id, task_id, workflow_name, status, summary, default_model,
        result_json, phases_json, logs_json, progress_json,
        agent_count, total_tokens, total_tool_calls, duration_ms, started_at, ended_at, ingested_at)
     VALUES
       (@run_id, @source_id, @session_id, @task_id, @workflow_name, @status, @summary, @default_model,
        @result_json, @phases_json, @logs_json, @progress_json,
        @agent_count, @total_tokens, @total_tool_calls, @duration_ms, @started_at, @ended_at, @ingested_at)
     ON CONFLICT(run_id) DO UPDATE SET
       source_id=excluded.source_id, session_id=excluded.session_id, task_id=excluded.task_id,
       workflow_name=excluded.workflow_name, status=excluded.status, summary=excluded.summary,
       default_model=excluded.default_model, result_json=excluded.result_json, phases_json=excluded.phases_json,
       logs_json=excluded.logs_json, progress_json=excluded.progress_json, agent_count=excluded.agent_count,
       total_tokens=excluded.total_tokens, total_tool_calls=excluded.total_tool_calls,
       duration_ms=excluded.duration_ms, started_at=excluded.started_at, ended_at=excluded.ended_at,
       ingested_at=excluded.ingested_at`,
  );

  ingestSidecars(db, sourceArchiveDir, excludedDirs, now, stats, full, {
    subdir: "workflows",
    // Only the run's own result file (wf_<id>.json); agent-*.meta.json / scripts are handled elsewhere.
    matchName: (name) => /^wf_.+\.json$/.test(name),
    handle: (path, buf) => {
      let d: Record<string, unknown>;
      try {
        const parsed = JSON.parse(buf.toString("utf8"));
        if (!parsed || typeof parsed !== "object") return false;
        d = parsed as Record<string, unknown>;
      } catch {
        return false;
      }
      const runId = strOrNull(d.runId) ?? basename(path, ".json");
      const startedAt = toIso(d.startTime) ?? toIso(d.timestamp);
      const durationMs = intOrNull(d.durationMs);
      const endedAt = startedAt && durationMs != null ? new Date(Date.parse(startedAt) + durationMs).toISOString() : null;
      upsert.run({
        run_id: runId,
        source_id: sourceId,
        session_id: sessionBefore(path, "workflows"),
        task_id: strOrNull(d.taskId),
        workflow_name: strOrNull(d.workflowName),
        status: strOrNull(d.status),
        summary: strOrNull(d.summary),
        default_model: cleanStr(d.defaultModel),
        result_json: jsonOrNull(d.result),
        phases_json: Array.isArray(d.phases) ? JSON.stringify(d.phases) : null,
        logs_json: Array.isArray(d.logs) ? JSON.stringify(d.logs) : null,
        progress_json: Array.isArray(d.workflowProgress) ? JSON.stringify(d.workflowProgress) : null,
        agent_count: intOrNull(d.agentCount),
        total_tokens: intOrNull(d.totalTokens),
        total_tool_calls: intOrNull(d.totalToolCalls),
        duration_ms: durationMs,
        started_at: startedAt,
        ended_at: endedAt,
        ingested_at: now,
      });
      return true;
    },
  });
}
