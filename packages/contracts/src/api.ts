/**
 * The HTTP **response** shapes: what `@agent-lens/server` returns and what the `web` SPA consumes
 * (ADR-026). Shared so a renamed field is a compile error on both sides instead of a runtime
 * `undefined` on one.
 *
 * These restate rows rather than wrap them — endpoints join, roll up and nest, so a response is
 * rarely just `Row[]`. `SessionDetailData` is the one exception: `getSession` does `SELECT s.*`, so
 * it genuinely extends `SessionRow`.
 *
 * Optionality convention, load-bearing here: `?` means the key can be **missing** from the JSON;
 * `| null` means the key is **always present** and may hold null. The server's degraded-DB guards
 * (`metaProjection`, the triage stand-ins in `listFindings`) emit `NULL AS …` precisely to keep the
 * shape stable, so `| null` is the common case and `?` is reserved for the genuinely conditional.
 *
 * The JSON-blob types (`FindingSignals`, `ClassificationSignals`, `WorkflowProgressEntry`, …) are
 * **asserted, not validated**: `safeJson()` returns `unknown` and these types are the assertion. A
 * malformed blob becomes null; a well-formed blob of the wrong shape reaches the UI as declared.
 * That is accepted — the only writers are this repo's ingest and detector. See ADR-026.
 */

import type { Severity, SessionRow, TurnRow } from "./rows.js";

// ---- Envelopes ----------------------------------------------------------

/** Every error response. `app.ts` emits this uniformly, so a client can always read `err.error.code`. */
export interface ApiError {
  error: { code: string; message: string };
}

/** GET /api/health — liveness plus the schema-staleness readout the header surfaces. */
export interface HealthResponse {
  ok: boolean;
  last_ingested: string | null;
  schema_version: number | null;
  /** True when the on-disk DB was written by an older schema (needs `agent-lens ingest --full`). */
  schema_stale: boolean;
  /**
   * The running build (ADR-027). Deliberately on `health` rather than `about`: it is the one part of
   * the diagnostics safe to publish, so the static Pages snapshot carries it and the version badge
   * works there too. Not always semver — a clone reports `v0.9.6-3-gabc1234`; read `version_source`
   * rather than parsing the string's shape.
   */
  version: string;
  version_source: VersionSource;
}

/** Which link of the version chain answered — see ADR-027 and `core/version.ts`. */
export type VersionSource = "npm" | "git" | "unknown";

/**
 * GET /api/about — the diagnostics surface (ADR-027). **Excluded from the static snapshot on
 * purpose**: it carries absolute filesystem paths, and `export-snapshot.mjs` publishes to a public
 * GitHub Pages demo. The SPA hides the whole page when `SNAPSHOT` is set.
 *
 * Read-only by design. Configuration resolves flag > env > config file > default, so a UI could only
 * ever write the third layer and would silently do nothing for anyone using env — hence values carry
 * their `origin` instead of being editable, mirroring `agent-lens config`.
 */
export interface AboutResponse {
  versions: {
    app: string;
    app_source: VersionSource;
    schema: number | null;
    schema_expected: number;
    schema_stale: boolean;
    /** Deterministic engines whose output is stamped per row — see EngineVersion. */
    detector: EngineVersion;
    classifier: EngineVersion;
  };
  /** Absolute paths, each with where the value came from. `config_file` is null when none is used. */
  paths: {
    config_file: string | null;
    data_dir: PathInfo;
    archive: PathInfo;
    db: PathInfo;
    triage_db: PathInfo;
  };
  server: { host: string; port: number; loopback_only: boolean };
  /** `.versions/` snapshot retention, mirroring the Retention block of `agent-lens config`. */
  retention: { versions_keep_days: number; origin: "env" | "default" };
  /**
   * Model pricing (ADR-028). Cost is derived at read time from a price table, so a model with no
   * rate reads as $0 rather than as an error — `unpriced` is how that becomes visible instead of
   * silently understating every total that includes it.
   */
  pricing: {
    /** "file" once a config override is in force, else "default". No flag/env layer exists. */
    origin: "file" | "default";
    /** Model-id prefixes the built-in table knows, after overrides. */
    models: number;
    /** Override keys applied from the config file. */
    applied: string[];
    /** Override keys rejected as malformed — reported, never applied. */
    invalid: string[];
    /** Models with real token usage in this store but no rate. Excludes `<synthetic>`. */
    unpriced: string[];
  };
  sources: Array<{ label: string; agent: string; config_dir: string }>;
  /**
   * `archive_bytes` is **ingested** bytes — `SUM(ingest_state.size)`, not `du` of the archive dir, so
   * anything present but not ingested (notably `.versions/` retention snapshots) is excluded. It is
   * "as of `last_ingested`" by construction, since ingest_state *is* the ingest bookkeeping.
   */
  storage: {
    db_bytes: number | null;
    archive_bytes: number;
    archive_files: number;
    last_ingested: string | null;
  };
}

export interface PathInfo {
  path: string;
  /** "fixed" = not independently relocatable (ADR-021); otherwise where the value was resolved from. */
  origin: "env" | "default" | "file" | "flag" | "fixed";
}

/**
 * A deterministic engine (detector, classifier) whose version is stamped onto every row it writes,
 * so stored output can be superseded when the rules change.
 *
 * Reporting `expected` alone would be misleading: it says what a *re-run* would produce, not what
 * produced the rows you are looking at. `in_data` is what is actually stamped in the store, so the
 * page can say "your findings came from v7, this build is v8" — which is the whole diagnostic.
 */
export interface EngineVersion {
  /** What this build stamps on rows it writes now. */
  expected: number;
  /** Distinct versions present in stored rows, ascending. Empty when nothing has been written yet. */
  in_data: number[];
  /** True when any stored row predates `expected` — re-running the engine would relabel it. */
  stale: boolean;
}

/** GET /api/prefs/:key — `value` is null both when unset and when no writable store is configured. */
export interface PrefResponse {
  value: unknown;
}

// ---- Shared primitives --------------------------------------------------

/** Token counts kept split: cache-read dominates and is never folded into a single "tokens" number. */
export interface TokenSplit {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
}

// Severity comes from the row half of this package (node-free) so web and server can't drift.
export type { Severity };

// ---- Filter dropdowns ---------------------------------------------------

export interface Project {
  id: string;
  path: string;
  session_count: number;
}

/** A labeled source (agent install) in the filter dropdowns. Shared by every view. */
export interface Source {
  id: string;
  label: string;
  session_count: number;
}

// ---- Sessions list ------------------------------------------------------

/**
 * A row of the sessions list. `title` is derived server-side (`ai_title || slug || null`) and the raw
 * columns behind it are deliberately NOT shipped — see the note on `SessionDetailData`, which is the
 * one shape that does carry them.
 */
export interface SessionSummary {
  id: string;
  title: string | null;
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
  /** Models in this session with no list price, so `cost` understates it. Empty when fully priced. */
  unpriced_models: string[];
  /** Tool-call roll-ups for the sessions-list Errors + Security columns. */
  tool_call_count: number;
  tool_error_count: number;
  finding_count: number;
  worst_severity: Severity | null;
}

/** GET /api/sessions — `total` is the whole filtered set, `sessions` the requested page of it. */
export interface SessionsPage {
  total: number;
  sessions: SessionSummary[];
}

// ---- Session detail / transcript ----------------------------------------

/**
 * A tool call, nested under its `EventNode`. Three columns the query needs are deliberately not on
 * the wire: `event_uuid` (the server has already used it to do the nesting), `error_type` (consumed
 * server-side for the failure-vs-rejection split, and surfaced to the UI as a dashboard breakdown,
 * never per-call), and `total_tokens` (nothing reads it).
 */
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
  /** From the subagent's meta sidecar (session_meta): authoritative type, human title, nesting depth.
   *  Null — never absent — when the table has no row or doesn't exist yet (see `metaProjection`). */
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

/** One derived file modification (ADR-022): a successful Edit/Write/NotebookEdit tool call's target. */
export interface FileChangeRow {
  id: string;
  tool_call_id: string;
  turn_id: string | null;
  /** The tool call's transcript event — deep-link anchor (#ev-<uuid>). */
  event_uuid: string | null;
  file_path: string;
  tool_name: string;
  lines_added: number | null;
  lines_removed: number | null;
  timestamp: string | null;
}

/** The session row on a detail payload: the stored `sessions` columns (shared SessionRow) plus the
 *  fields getSession computes/joins on — project path, cost/token roll-ups, and the error split. */
export interface SessionDetailData extends SessionRow {
  project_path: string | null;
  tokens: number;
  token_split: TokenSplit;
  cost: number;
  /** Models in this session with no list price, so `cost` understates it. Empty when fully priced. */
  unpriced_models: string[];
  title: string | null;
  tool_call_count: number;
  tool_error_count: number;
  tool_rejection_count: number;
  tool_failure_count: number;
}

export interface SessionDetail {
  session: SessionDetailData;
  turns: TurnRow[];
  events: EventNode[];
  classification: Classification | null;
  parent: SessionParent | null;
  children: SessionChild[];
  workflow_runs: WorkflowRun[];
  /** Security findings across this session (ADR-017), most-severe first — for the header summary. */
  findings: Finding[];
  /** File modifications derived from this session's Edit/Write tool calls (ADR-022), chronological —
   * for the "Files changed" header roll-up. Empty on a pre-v14 DB. */
  file_changes: FileChangeRow[];
}

// ---- Security findings (ADR-017) + triage (ADR-018) ---------------------

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
/**
 * One security finding — a (tool_call, rule) match, as returned inline on a session detail.
 *
 * Note there is no `session_id`: the inline projection omits it as redundant (you already know the
 * session you are reading), and the /security list rows that DO carry it are `FindingListRow`.
 * Before ADR-026 this was declared required on both and silently unmet on one.
 */
export interface Finding {
  id: string;
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
  /** Present in the inline session projection; absent from the /security list, which doesn't
   *  select `signals_json`. Genuinely conditional, hence `?` rather than `| null`. */
  signals?: FindingSignals | null;
  // Present in the /security list projection (listFindings), absent in the inline session projection.
  session_title?: string | null;
  source_id?: string | null;
  is_sidechain?: number;
  project_path?: string | null;
  project_id?: string | null;
  /** Session timestamp — the "when" column. */
  started_at?: string | null;
  // Triage state (ADR-018). Present on every /security list row: `listFindings` emits 0/NULL
  // stand-ins when the triage store isn't ATTACHed, so the shape doesn't depend on configuration.
  dismissed?: number;
  dismiss_note?: string | null;
  dismissed_at?: string | null;
  muted?: number;
}

/**
 * A row of the /security list. The list projection joins `sessions`, so it always carries the session
 * context that the inline (per-transcript) projection leaves out — most importantly `session_id`,
 * which every row in this list links to.
 *
 * This split is the honest form of a mismatch ADR-026 turned up: `Finding.session_id` was declared
 * required and the inline projection never emitted it. Narrowing it here keeps the list callers
 * unguarded without lying about the inline case.
 */
export interface FindingListRow extends Finding {
  session_id: string;
}

export interface FindingsPage {
  total: number;
  findings: FindingListRow[];
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

// ---- Skills -------------------------------------------------------------

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

// ---- File provenance (ADR-022) ------------------------------------------

/** One (project, file) aggregate row of GET /api/files. */
export interface FileSummary {
  project_id: string | null;
  project_path: string | null;
  file_path: string;
  sessions: number;
  changes: number;
  lines_added: number | null;
  lines_removed: number | null;
  first_ts: string | null;
  last_ts: string | null;
}

/** GET /api/files — same count-then-page envelope as the sessions list. */
export interface FilesPage {
  total: number;
  files: FileSummary[];
}

/** One change entry inside a file's provenance timeline, deep-linkable to its transcript event. */
export interface FileTimelineChange {
  id: string;
  turn_id: string | null;
  turn_seq: number | null;
  prompt_preview: string | null;
  event_uuid: string | null;
  tool_name: string;
  lines_added: number | null;
  lines_removed: number | null;
  timestamp: string | null;
}

/** One session's group in a file's provenance timeline (GET /api/file). */
export interface FileTimelineSession {
  session_id: string;
  title: string | null;
  source_id: string | null;
  started_at: string | null;
  category: string | null;
  changes: FileTimelineChange[];
}

export interface FileTimeline {
  file_path: string;
  project_id: string | null;
  project_path: string | null;
  sessions_count: number;
  changes_count: number;
  lines_added: number;
  lines_removed: number;
  first_ts: string | null;
  last_ts: string | null;
  sessions: FileTimelineSession[];
}

// ---- Workflow runs ------------------------------------------------------

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

/** The workflow's completion message, parsed from the `<task-notification>` posted back to the
 * launching session. `result` is the workflow's returned payload (often JSON); `failures` lists any
 * per-item errors. Null when no completion notification has been ingested yet. */
export interface WorkflowCompletion {
  status: string | null;
  summary: string | null;
  result: string | null;
  failures: string | null;
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

/** A Workflow-tool run's detail page payload: the launching tool_call + parent crumb, every spawned
 * agent, and roll-up stats. Served by GET /api/workflows/:run_id (getWorkflow in db.ts). */
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
  parent: SessionParent;
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

// ---- Dashboard aggregates -----------------------------------------------

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
  /** End-to-end session-length percentiles over main sessions (excludes subagents & null durations). */
  session_duration_ms: { p50: number; p95: number; count: number };
  /** Async-workflow run rollup: outcomes by status, success rate over decided runs, token/duration sums. */
  workflows: {
    total: number;
    by_status: Array<{ status: string; n: number }>;
    completed: number;
    failed: number;
    success_rate: number;
    total_tokens: number;
    avg_duration_ms: number;
  };
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
  /** `token_usage.model` is nullable and this group-by (unlike the model *filter* list) does not
   *  exclude nulls, so the query COALESCEs the bucket to `(unknown)` — same convention as by_source. */
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
