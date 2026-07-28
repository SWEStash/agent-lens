/**
 * The normalized DB **row** shapes that cross package boundaries — a mirror of the DDL in
 * @agent-lens/core's schema.ts (ADR-024). One row interface per table, named for the table.
 *
 * A row is what the store holds; what an endpoint *returns* is a response, and those live in
 * `./api.ts` (ADR-026) — they reshape rows with joins and roll-ups and are rarely just `Row[]`.
 *
 * See `./index.ts` for the leaf guarantee this file must not break.
 */

/** Security-finding severity, lowest → highest. Shared so the detector, server, and web agree. */
export type Severity = "info" | "low" | "medium" | "high" | "critical";

export interface SourceRow {
  id: string;
  label: string;
  agent_id: string;
  config_dir: string | null;
}

export interface ProjectRow {
  id: string;
  agent_id: string;
  path: string;
  encoded_dir: string | null;
  first_seen: string | null;
  last_seen: string | null;
}

export interface SessionRow {
  id: string;
  agent_id: string;
  source_id: string | null;
  project_id: string | null;
  slug: string | null;
  ai_title: string | null;
  cli_version: string | null;
  entrypoint: string | null;
  git_branch: string | null;
  is_sidechain: number;
  spawn_parent_id: string | null;
  workflow_run_id: string | null;
  parent_session_id: string | null;
  parent_turn_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  event_count: number;
  turn_count: number;
}

export interface TurnRow {
  id: string;
  session_id: string;
  seq: number;
  user_event_uuid: string | null;
  prompt_preview: string | null;
  model: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
}

export interface EventRow {
  uuid: string;
  session_id: string;
  turn_id: string | null;
  parent_uuid: string | null;
  seq: number | null;
  type: string;
  role: string | null;
  timestamp: string | null;
  model: string | null;
  is_sidechain: number;
  is_meta: number;
  text: string | null;
  raw_json: string;
  source_file: string | null;
}

export interface TokenUsageRow {
  event_uuid: string;
  session_id: string;
  turn_id: string | null;
  message_id: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  service_tier: string | null;
}

export interface ToolCallRow {
  id: string;
  event_uuid: string | null;
  session_id: string;
  turn_id: string | null;
  tool_name: string;
  caller: string | null;
  skill_name: string | null;
  /** the specific skill *version* (content hash) this call fired; set in rebuildDerived, null until then / when no body was captured */
  skill_id: string | null;
  agent_type: string | null;
  spawned_session_id: string | null;
  workflow_run_id: string | null;
  workflow_name: string | null;
  resolved_model: string | null;
  status: string | null;
  total_duration_ms: number | null;
  total_tokens: number | null;
  total_tool_use_count: number | null;
  input_json: string | null;
  result_summary: string | null;
}

/**
 * A content-addressed skill *version*. Built in rebuildDerived from the SKILL.md body that a Skill
 * firing injects into the transcript. `id` is the hash of the normalized body, so a skill that
 * changes content yields a new row; firings of unchanged content collapse to one row.
 */
export interface SkillRow {
  id: string;
  name: string;
  base_dir: string | null;
  body: string;
  summary: string | null;
  body_bytes: number | null;
  first_seen: string | null;
  last_seen: string | null;
}

/**
 * A heuristic classification of a session (or, later, a turn). Re-runnable and deterministic:
 * `signals_json` records the inputs/sub-scores so a result can be explained and bands retuned,
 * and `classifier_version` lets a future (e.g. local-LLM) classifier supersede heuristic rows.
 */
export interface ClassificationRow {
  scope: "session" | "turn";
  target_id: string;
  category: string | null;
  complexity_score: number | null;
  complexity_band: string | null;
  signals_json: string | null;
  classifier_version: number;
}
