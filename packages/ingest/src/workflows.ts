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
 * Idempotent: keyed by run id, UPSERT on re-ingest; a stat short-circuit (ingest_state) skips
 * unchanged files. Excluded projects are filtered out at discovery.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DB } from "./db.js";
import { isExcludedArchivePath } from "./redact.js";
import { sha256 } from "./fileread.js";

export interface WorkflowIngestStats {
  files: number;
  upserted: number;
  skipped: number;
  malformed: number;
}

export function newWorkflowStats(): WorkflowIngestStats {
  return { files: 0, upserted: 0, skipped: 0, malformed: 0 };
}

/** Recursively find `wf_*.json` sidecars living directly inside a `workflows/` directory. */
function walkSidecars(dir: string, inWorkflows: boolean, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkSidecars(p, inWorkflows || e.name === "workflows", out);
    // Only the run's own result file (wf_<id>.json); agent-*.meta.json / scripts are handled elsewhere.
    else if (e.isFile() && inWorkflows && /^wf_.+\.json$/.test(e.name)) out.push(p);
  }
}

/** All sidecar paths under a source archive (mirror first, then each .versions snapshot). */
function discoverSidecars(sourceArchiveDir: string): string[] {
  const out: string[] = [];
  walkSidecars(join(sourceArchiveDir, "projects"), false, out);
  try {
    for (const ts of readdirSync(join(sourceArchiveDir, ".versions"), { withFileTypes: true }))
      if (ts.isDirectory()) walkSidecars(join(sourceArchiveDir, ts.name, "projects"), false, out);
  } catch {
    /* no versions yet */
  }
  return out;
}

/** Launching session id = the path segment immediately before `workflows/`. */
function sessionFromPath(path: string): string | null {
  const parts = path.split("/");
  const i = parts.indexOf("workflows");
  return i > 0 ? parts[i - 1] : null;
}

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
const intOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

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
  let paths = discoverSidecars(sourceArchiveDir);
  if (excludedDirs.length) paths = paths.filter((p) => !isExcludedArchivePath(p, excludedDirs));
  // Mirror last so it wins over any older .versions snapshot on UPSERT (a run that went
  // running→completed diverges: the completed copy is in the mirror).
  paths.sort((a, b) => Number(a.includes("/.versions/")) - Number(b.includes("/.versions/")) || (a < b ? -1 : 1));

  const getState = db.prepare("SELECT size, mtime_ms, sha256 FROM ingest_state WHERE file_path = ?");
  const setState = db.prepare(
    `INSERT INTO ingest_state (file_path, size, mtime_ms, sha256, events_ingested, ingested_at)
     VALUES (@file_path, @size, @mtime_ms, @sha256, 0, @ingested_at)
     ON CONFLICT(file_path) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms, sha256=excluded.sha256, ingested_at=excluded.ingested_at`,
  );
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

  for (const path of paths) {
    stats.files++;
    const st = statSync(path);
    const mtimeMs = Math.trunc(st.mtimeMs);
    const prev = full ? undefined : (getState.get(path) as { size: number; mtime_ms: number; sha256: string } | undefined);
    if (prev && prev.size === st.size && prev.mtime_ms === mtimeMs) {
      stats.skipped++;
      continue;
    }
    let buf: Buffer;
    try {
      buf = readFileSync(path);
    } catch {
      stats.malformed++;
      continue;
    }
    const hash = sha256(buf);
    if (prev && prev.sha256 === hash) {
      setState.run({ file_path: path, size: st.size, mtime_ms: mtimeMs, sha256: hash, ingested_at: now });
      stats.skipped++;
      continue;
    }

    let d: any;
    try {
      d = JSON.parse(buf.toString("utf8"));
    } catch {
      stats.malformed++;
      continue;
    }
    if (!d || typeof d !== "object") {
      stats.malformed++;
      continue;
    }

    const runId = strOrNull(d.runId) ?? basename(path, ".json");
    const startedAt = toIso(d.startTime) ?? toIso(d.timestamp);
    const durationMs = intOrNull(d.durationMs);
    const endedAt = startedAt && durationMs != null ? new Date(Date.parse(startedAt) + durationMs).toISOString() : null;

    upsert.run({
      run_id: runId,
      source_id: sourceId,
      session_id: sessionFromPath(path),
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
    setState.run({ file_path: path, size: st.size, mtime_ms: mtimeMs, sha256: hash, ingested_at: now });
    stats.upserted++;
  }
}
