// Snapshot mode: when built with VITE_SNAPSHOT=1 the SPA is a static, read-only bundle (e.g. GitHub
// Pages) with no live API — each endpoint's default response was pre-exported to
// `<base>/snapshot/<path>.json` by scripts/export-snapshot.mjs. Query params (filters, pagination)
// are stripped, so the snapshot always serves the default unfiltered view.
export const SNAPSHOT = (import.meta as any).env?.VITE_SNAPSHOT === "1";
const BASE = (import.meta as any).env?.BASE_URL ?? "/";

function resolveUrl(path: string): string {
  if (!SNAPSHOT) return "/api" + path;
  const clean = path.split("?")[0].replace(/^\//, ""); // drop query + leading slash → snapshot key
  return `${BASE}snapshot/${clean}.json`;
}

/** URL for a session's Markdown export — the live API route, or the pre-rendered static file in
 * snapshot mode. */
export function exportUrl(id: string): string {
  return SNAPSHOT ? `${BASE}snapshot/sessions/${id}.export.md` : `/api/sessions/${id}/export.md`;
}

export async function api<T = any>(path: string): Promise<T> {
  const r = await fetch(resolveUrl(path));
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

/** POST to a live API route (never used in snapshot mode — there is no backend). Same-origin, so the
 * browser sends the Origin header the server's CSRF guard checks; no custom header (avoids preflight). */
export async function apiPost<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await fetch("/api" + path, {
    method: "POST",
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

export interface SessionSummary {
  id: string;
  title: string | null;
  slug: string | null;
  source_id: string | null;
  is_sidechain: number;
  started_at: string | null;
  duration_ms: number | null;
  event_count: number;
  turn_count: number;
  project_path: string | null;
  models: string | null;
  tokens: number;
  token_split: TokenSplit;
  cost: number;
  /** Tool-call roll-ups for the sessions-list Errors + Security columns. */
  tool_call_count: number;
  tool_error_count: number;
  finding_count: number;
  worst_severity: Severity | null;
}

export interface Project {
  id: string;
  path: string;
  session_count: number;
}

export interface ToolCall {
  id: string | null;
  tool_name: string;
  skill_name: string | null;
  /** the specific skill version (content hash) this call fired; null when no body was captured */
  skill_id: string | null;
  agent_type: string | null;
  spawned_session_id: string | null;
  workflow_run_id: string | null;
  workflow_name: string | null;
  workflow_agent_count: number | null;
  status: string | null;
  total_duration_ms: number | null;
  input_json: string | null;
  result_summary: string | null;
  /** Present when the transcript truncated this result to a "…/tool-results/<name>.txt" marker and the
   * spilled full output has been ingested — lets the UI expand to the un-truncated text. */
  full_result?: { text: string; bytes: number } | null;
  /** Security findings raised on this tool call (ADR-017) — drives the inline severity badge + panel. */
  findings?: Finding[];
}

export type Severity = "info" | "low" | "medium" | "high" | "critical";

/** The explainability blob behind a finding, written verbatim by the detector (detect.ts). */
export interface FindingSignals {
  rule: string;
  category: string;
  framework_ref: string;
  tool_name: string;
  base_severity: Severity;
  severity: Severity;
  status: string | null;
  modifiers: Record<string, unknown>;
  detector_version: number;
}

/** One security finding — a (tool_call, rule) match. List rows also carry session context. */
export interface Finding {
  id: string;
  session_id: string;
  tool_call_id: string | null;
  event_uuid: string | null;
  turn_id: string | null;
  rule_id: string;
  category: string;
  framework_ref: string | null;
  severity: Severity;
  title: string | null;
  evidence: string | null;
  /** The tool the finding fired on (Bash/Read/Write/…) — clarifies path-only evidence. */
  tool_name?: string | null;
  signals?: FindingSignals | null;
  // Present in the /security list projection (listFindings), absent in the inline session projection.
  session_title?: string | null;
  source_id?: string | null;
  is_sidechain?: number;
  project_path?: string | null;
  project_id?: string | null;
  /** Session timestamp — the "when" column. */
  started_at?: string | null;
  // Triage state (ADR-018), present when the triage store is attached.
  dismissed?: number;
  dismiss_note?: string | null;
  dismissed_at?: string | null;
  muted?: number;
}

export interface FindingsPage {
  total: number;
  findings: Finding[];
}

/** A muted rule (GET /api/security/mutes) — suppresses its findings from the open view. */
export interface MuteRow {
  rule_id: string;
  scope: string;
  scope_id: string;
  note: string | null;
  muted_at: string;
}

/** Framework-anchored reference content for a category (from core: SECURITY_CATEGORIES). */
export interface SecurityCategoryRef {
  key: string;
  title: string;
  framework_ref: string;
  framework_url: string;
  what: string;
  why: string;
  remediation: string;
}

/** GET /api/security/summary — roll-up for the page header + Dashboard KPI + reference explainers. */
export interface SecuritySummary {
  /** Counts below are over OPEN findings (dismissed + muted excluded). */
  total: number;
  sessions_flagged: number;
  dismissed: number;
  muted: number;
  by_severity: Array<{ severity: Severity; n: number }>;
  by_category: Array<{ category: string; n: number }>;
  by_rule: Array<{ rule_id: string; category: string; title: string | null; n: number; rank: number }>;
  categories: SecurityCategoryRef[];
}

export interface EventNode {
  uuid: string;
  type: string;
  role: string | null;
  timestamp: string | null;
  model: string | null;
  is_sidechain: number;
  turn_id: string | null;
  text: string | null;
  thinking: string | null;
  toolCalls: ToolCall[];
}

/** The evidence blob behind a classification, written verbatim by the heuristic classifier
 * (packages/ingest/src/classify.ts). Every input and sub-score is recorded so a verdict can be
 * explained and the bands retuned. Optional fields guard against older classifier_version rows. */
export interface ClassificationSignals {
  tool_counts?: Record<string, number>;
  skills?: Record<string, number>;
  loc?: { added: number; removed: number; net: number; churn: number; files: number };
  files?: string[];
  turn_count?: number;
  event_count?: number;
  work_tokens?: number;
  cache_read_tokens?: number;
  duration_ms?: number;
  subagent_count?: number;
  is_sidechain?: number;
  subagent_role?: string | null;
  category_scores?: Record<string, number>;
  complexity_subscores?: Record<string, number>;
  complexity_weights?: Record<string, number>;
  classifier_version?: number;
}

export interface Classification {
  category: string | null;
  complexity_score: number | null;
  complexity_band: string | null;
  classifier_version: number;
  signals: ClassificationSignals | null;
}

export interface SessionParent {
  id: string;
  title: string | null;
  turn_seq: number | null;
}

export interface SessionChild {
  id: string;
  title: string | null;
  turn_count: number;
  started_at: string | null;
  models: string | null;
  tokens: number;
  cost: number;
  workflow_run_id: string | null;
  /** From the subagent's meta sidecar (session_meta): authoritative type, human title, nesting depth. */
  agent_type: string | null;
  agent_description: string | null;
  spawn_depth: number | null;
}

/** A Workflow-tool run launched from a session: its id, name, the turn that started it, and how many
 * subagents it fanned out to. Lets the UI group the fan-out by run instead of one flat list. */
export interface WorkflowRun {
  run_id: string;
  name: string | null;
  turn_seq: number | null;
  agent_count: number;
  /** Run status from the result sidecar (completed/failed/…); null when not yet ingested. */
  status: string | null;
}

export interface SessionDetail {
  session: any;
  turns: any[];
  events: EventNode[];
  classification: Classification | null;
  parent: SessionParent | null;
  children: SessionChild[];
  workflow_runs: WorkflowRun[];
  /** Security findings across this session (ADR-017), most-severe first — for the header summary. */
  findings: Finding[];
}

/** One subagent fanned out by a Workflow run, with its roll-up tokens/cost for the run's agent list. */
export interface WorkflowAgent {
  id: string;
  title: string | null;
  turn_count: number;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  models: string | null;
  tokens: number;
  cost: number;
  /** From the agent's meta sidecar (session_meta): authoritative type, human title, nesting depth. */
  agent_type: string | null;
  agent_description: string | null;
  spawn_depth: number | null;
}

/** A Workflow-tool run's detail page payload: the launching tool_call + parent crumb, every spawned
 * agent, and roll-up stats. Served by GET /api/workflows/:run_id (getWorkflow in db.ts). */
/** The workflow's completion message, parsed from the `<task-notification>` posted back to the
 * launching session. `result` is the workflow's returned payload (often JSON); `failures` lists any
 * per-item errors. Null when no completion notification has been ingested yet. */
export interface WorkflowCompletion {
  status: string | null;
  summary: string | null;
  result: string | null;
  failures: string | null;
}

/** The Workflow runner's self-reported roll-up, from the ingested wf_<id>.json result sidecar. */
export interface WorkflowRunResult {
  status: string | null;
  summary: string | null;
  default_model: string | null;
  agent_count: number | null;
  total_tokens: number | null;
  total_tool_calls: number | null;
  duration_ms: number | null;
  started_at: string | null;
  ended_at: string | null;
  phases: Array<{ title?: string }> | null;
  logs: string[] | null;
  /** The runner's workflowProgress event timeline: interleaved phase markers and per-agent entries.
   * Powers the phase graph's per-phase descriptor (agent count, models). Null on older/failed runs. */
  progress: WorkflowProgressEntry[] | null;
}

/** One entry in a run's workflowProgress: either a phase marker or a spawned-agent record. */
export type WorkflowProgressEntry =
  | { type: "workflow_phase"; index: number; title?: string }
  | {
      type: "workflow_agent";
      index?: number;
      label?: string;
      phaseIndex?: number;
      phaseTitle?: string;
      agentId?: string;
      model?: string;
      state?: string;
      tokens?: number;
      toolCalls?: number;
      durationMs?: number;
    };

export interface WorkflowDetail {
  run_id: string;
  name: string | null;
  status: string | null;
  result_summary: string | null;
  /** The Workflow tool's launch payload (scriptPath/script/description + the task list). Rendered by
   * LaunchView; the primary content for async launches that have no completion yet. */
  input_json: string | null;
  completion: WorkflowCompletion | null;
  /** The runner's own result sidecar roll-up (model, tokens, tool calls, phases, per-item logs,
   * duration, agent count) — present once the wf_<id>.json sidecar is ingested; null otherwise. */
  run: WorkflowRunResult | null;
  parent: { id: string; title: string | null; turn_seq: number | null };
  agents: WorkflowAgent[];
  stats: {
    agent_count: number;
    total_tokens: number;
    total_cost: number;
    started_at: string | null;
    ended_at: string | null;
    duration_ms: number | null;
  };
}

export interface TokenSplit {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
}

/** One row in the Skills list (GET /api/skills) — a fired skill grouped by name. */
export interface SkillSummary {
  name: string;
  call_count: number;
  version_count: number;
  last_fired: string | null;
  sources: string[];
}

/** A content-addressed version of a skill (its captured SKILL.md body + firing stats). */
export interface SkillVersion {
  id: string;
  base_dir: string | null;
  summary: string | null;
  body: string;
  body_bytes: number | null;
  first_seen: string | null;
  last_seen: string | null;
  call_count: number;
}

/** A session that fired a skill, tagged with which version (version_id) it fired. */
export interface SkillSession {
  id: string;
  title: string | null;
  slug: string | null;
  source_id: string | null;
  started_at: string | null;
  project_path: string | null;
  version_id: string | null;
  fired_at: string | null;
  fire_count: number;
}

/** GET /api/skills/:name — every version of a skill + the sessions that fired it. */
export interface SkillDetail {
  name: string;
  versions: SkillVersion[];
  sessions: SkillSession[];
  call_count: number;
}

export interface DashOverview {
  range: { from: string | null; to: string | null; source: string | null };
  sessions: number;
  sessions_main: number;
  sessions_subagent: number;
  turns: number;
  projects: number;
  tool_calls: number;
  tokens: TokenSplit;
  total_tokens: number;
  cache_read_ratio: number;
  cost: number;
  unpriced_models: string[];
  turn_duration_ms: { p50: number; p95: number; count: number };
}

export interface TimeseriesPoint extends TokenSplit {
  bucket: string;
  cost: number;
  sessions: number;
  turns: number;
  /** Errored tool calls in this bucket, split into genuine failures vs user/guardrail rejections. */
  failures: number;
  rejections: number;
}
export interface DashTimeseries {
  bucket: "day" | "week" | "month";
  series: TimeseriesPoint[];
}

export interface DashBreakdowns {
  by_model: Array<{ model: string; tokens: TokenSplit; total_tokens: number; cost: number; sessions: number; priced: boolean }>;
  by_source: Array<{ source: string; sessions: number; turns: number }>;
  by_category: Array<{ category: string; n: number }>;
  by_complexity: Array<{ band: string; n: number }>;
  tools: Array<{ name: string; n: number }>;
  skills: Array<{ name: string; n: number }>;
  skill_versions: Array<{ name: string; version_id: string; summary: string | null; last_seen: string | null; n: number }>;
  subagent_fanout: {
    by_type: Array<{ type: string; n: number }>;
    sessions_with_subagents: number;
    total_spawns: number;
    max_per_session: number;
    avg_per_session: number;
  };
  /** Errored tool calls by heuristic error_type (raw count authoritative, bucket heuristic — see errors.ts). */
  error_types: {
    by_type: Array<{ type: string; kind: "failure" | "rejection"; n: number }>;
    failures: number;
    rejections: number;
  };
}
