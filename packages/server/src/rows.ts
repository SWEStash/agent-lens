/**
 * The **query-projection** shapes: what a specific `SELECT` in this package hands back, for the cases
 * where that is neither a `@agent-lens/contracts` row nor a finished response.
 *
 * Three kinds of shape meet here, and keeping them apart is the point (ADR-026):
 *
 * - a **row** (`@agent-lens/contracts` `rows.ts`) mirrors a table's DDL;
 * - a **projection** (this file) is one query's column list — a join, a subquery roll-up, an
 *   aggregate with short aliases — which usually matches no table at all;
 * - a **response** (`@agent-lens/contracts` `api.ts`) is what an endpoint returns.
 *
 * Name each projection for the loader that issues it. They exist so `queryAll<T>` has something
 * honest to be parameterized with: the cast still isn't checked against the SQL (SQLite has
 * no static knowledge of a query's columns), but it is written down once, next to a name, instead of
 * being an `any` that silently absorbs whatever the response assembly then claims about it.
 */

import type { Severity, ToolCall } from "@agent-lens/contracts";

/**
 * A tool call as the QUERY returns it: the response shape plus the two columns the loaders need but
 * the response deliberately does not ship — `event_uuid` (used to nest calls under their event) and
 * `error_type` (used for the failure-vs-rejection split). `toResponseToolCall` in db.ts drops them
 * at the point of nesting, which is the only place the distinction has to be made.
 */
export interface ToolCallProjection extends ToolCall {
  event_uuid: string | null;
  error_type: string | null;
}

/** `SELECT COUNT(*) n …` — the count half of every count-then-page endpoint. */
export interface CountRow {
  n: number;
}

/** `SELECT DISTINCT model …` for the model filter dropdown. */
export interface ModelRow {
  model: string;
}

/** The `sessions` list projection: stored columns + the project join + four subquery roll-ups.
 *  Becomes a `SessionSummary` once `attachSessionCost` adds the costed fields. */
export interface SessionListRow {
  id: string;
  ai_title: string | null;
  slug: string | null;
  source_id: string | null;
  is_sidechain: number;
  started_at: string | null;
  duration_ms: number | null;
  event_count: number;
  turn_count: number;
  project_path: string | null;
  models: string | null;
  tool_call_count: number;
  tool_error_count: number;
  finding_count: number;
  /** The worst severity across the session's findings, or null when it has none. */
  worst_severity: Severity | null;
}

/** The spilled full output of a truncated tool result (`tool_results`). */
export interface ToolResultRow {
  text: string;
  bytes: number;
}

/** The `findings` projection attached inline to a session's tool calls: the stored columns plus the
 *  raw `signals_json`, which the loader parses into `Finding.signals`. */
export interface FindingProjectionRow {
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
  signals_json: string | null;
}

/** The `events` projection for a transcript: display columns only. `text` and `thinking` are stored
 *  split (schema v15), so reading a transcript no longer unpacks and re-parses `raw_json` per event —
 *  the ingest adapter is the only thing that reads a record's shape (ADR-008). */
export interface EventProjectionRow {
  uuid: string;
  type: string;
  role: string | null;
  timestamp: string | null;
  model: string | null;
  is_sidechain: number;
  turn_id: string | null;
  text: string | null;
  thinking: string | null;
}

/** The `classifications` projection, with `signals_json` still unparsed. */
export interface ClassificationProjectionRow {
  category: string | null;
  complexity_score: number | null;
  complexity_band: string | null;
  signals_json: string | null;
  classifier_version: number;
}

/** Just the category — the per-session lookup the file timeline does inside its grouping loop. */
export interface CategoryRow {
  category: string | null;
}

/** The spawning parent: the parent session's title columns plus the launching turn's sequence. */
export interface SessionParentRow {
  id: string;
  ai_title: string | null;
  slug: string | null;
  turn_seq: number | null;
}

/** A spawned subagent, before its tokens/cost/title are computed. The `session_meta` columns are
 *  `NULL AS …` stand-ins when that table is absent, so they are always present (see `metaProjection`). */
export interface SessionChildRow {
  id: string;
  ai_title: string | null;
  slug: string | null;
  turn_count: number;
  started_at: string | null;
  workflow_run_id: string | null;
  models: string | null;
  agent_type: string | null;
  agent_description: string | null;
  spawn_depth: number | null;
}

/** A workflow run's subagent: `SessionChildRow`'s columns plus the wall-clock span the run page shows. */
export interface WorkflowAgentRow {
  id: string;
  ai_title: string | null;
  slug: string | null;
  turn_count: number;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  models: string | null;
  agent_type: string | null;
  agent_description: string | null;
  spawn_depth: number | null;
}

/** The launching `Workflow` tool call, joined to its turn and parent session. */
export interface WorkflowLaunchRow {
  tool_use_id: string | null;
  run_id: string;
  name: string | null;
  status: string | null;
  result_summary: string | null;
  input_json: string | null;
  parent_session_id: string;
  turn_seq: number | null;
  parent_ai_title: string | null;
  parent_slug: string | null;
}

/** The runner's own result sidecar (`workflow_results`), JSON columns still packed. */
export interface WorkflowResultRow {
  status: string | null;
  summary: string | null;
  default_model: string | null;
  result_json: string | null;
  phases_json: string | null;
  logs_json: string | null;
  progress_json: string | null;
  agent_count: number | null;
  total_tokens: number | null;
  total_tool_calls: number | null;
  duration_ms: number | null;
  started_at: string | null;
  ended_at: string | null;
}

/** The Skills list aggregate. `sources` arrives as a `GROUP_CONCAT` string and is split into the
 *  array the response declares. */
export interface SkillListRow {
  name: string;
  call_count: number;
  version_count: number;
  last_fired: string | null;
  sources: string | null;
}

/** A session that fired a skill, before its display `title` is derived. */
export interface SkillSessionRow {
  id: string;
  ai_title: string | null;
  slug: string | null;
  source_id: string | null;
  started_at: string | null;
  project_path: string | null;
  version_id: string | null;
  fired_at: string | null;
  fire_count: number;
}

/** One row of a file's provenance timeline: the change, its session, its turn, its project. Grouped
 *  by session into `FileTimelineSession`s by the loader. */
export interface FileTimelineRow {
  id: string;
  session_id: string;
  turn_id: string | null;
  event_uuid: string | null;
  tool_name: string;
  lines_added: number | null;
  lines_removed: number | null;
  timestamp: string | null;
  project_id: string | null;
  ai_title: string | null;
  slug: string | null;
  source_id: string | null;
  started_at: string | null;
  turn_seq: number | null;
  prompt_preview: string | null;
  project_path: string | null;
}

// ---- Dashboard aggregates ----------------------------------------------
// These use short SQL aliases (i/o/cw/cr, b, n, d) so the GROUP BY expressions stay readable; the
// shapes below are where those aliases are given a meaning. SUM() over no rows is NULL in SQLite,
// hence the nullable numbers — every consumer coalesces with `?? 0`.

/** Per-model token sums: input / output / cache-write / cache-read. */
export interface UsageAggRow {
  model: string | null;
  i: number | null;
  o: number | null;
  cw: number | null;
  cr: number | null;
}

/** `UsageAggRow` bucketed by a `strftime` expression (the timeseries). */
export interface BucketUsageAggRow extends UsageAggRow {
  b: string | null;
}

/** A plain per-bucket count (sessions, turns). */
export interface BucketCountRow {
  b: string | null;
  n: number;
}

/** Errored tool calls per bucket, grouped by the heuristic error_type. */
export interface BucketErrorRow {
  b: string | null;
  et: string | null;
  n: number;
}

/** The overview's session/turn/project counters. `SUM`/`COUNT` over no rows is NULL. */
export interface OverviewCountsRow {
  sessions: number | null;
  main: number | null;
  subagent: number | null;
  turns: number | null;
  projects: number | null;
}

/** The started_at span used to choose a bucket width. */
export interface SpanRow {
  mn: string | null;
  mx: string | null;
}

/** Per-status workflow-run aggregate, with the duration count needed for a mean over non-null spans. */
export interface WorkflowStatusAggRow {
  status: string;
  n: number;
  tokens: number | null;
  dur: number | null;
  dur_n: number | null;
}

/** `UsageAggRow` plus the distinct-session count, for the by-model breakdown. `model` narrows to
 *  non-null here because that query COALESCEs the bucket label to `(unknown)`. */
export interface ModelBreakdownRow extends UsageAggRow {
  model: string;
  sessions: number | null;
}
