/**
 * Normalized row shapes (mirror of the DDL in schema.ts) and the source-adapter contract.
 * These types are the boundary every agent adapter emits into — keep them agent-agnostic.
 */

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
  project_id: string | null;
  slug: string | null;
  ai_title: string | null;
  cli_version: string | null;
  entrypoint: string | null;
  git_branch: string | null;
  is_sidechain: number;
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
  agent_type: string | null;
  resolved_model: string | null;
  status: string | null;
  total_duration_ms: number | null;
  total_tokens: number | null;
  total_tool_use_count: number | null;
  input_json: string | null;
  result_summary: string | null;
}

/** Patch applied to a previously-seen tool_call once its result line arrives. */
export interface ToolResultPatch {
  tool_use_id: string;
  status?: string | null;
  agent_type?: string | null;
  resolved_model?: string | null;
  total_duration_ms?: number | null;
  total_tokens?: number | null;
  total_tool_use_count?: number | null;
  result_summary?: string | null;
}

/** Session-level metadata accumulated from envelopes and pointer lines. */
export interface SessionMeta {
  cwd?: string;
  slug?: string;
  ai_title?: string;
  cli_version?: string;
  entrypoint?: string;
  git_branch?: string;
  is_sidechain?: boolean;
}

/** What an adapter produces for a single raw transcript line. */
export interface ParsedLine {
  event?: EventRow;
  tokenUsage?: TokenUsageRow;
  toolCalls?: ToolCallRow[];
  toolResults?: ToolResultPatch[];
  meta?: SessionMeta;
}

/** A transcript file discovered in the archive. */
export interface SourceFile {
  path: string;
  sessionId: string;
  encodedDir: string;
  /** true if from .versions/<ts>/ (a divergence/compaction backup) rather than the mirror */
  isVersion: boolean;
}

/**
 * A source adapter knows how to find and parse one agent's traces. Claude Code is the first;
 * other agents add a new adapter without touching the schema.
 */
export interface SourceAdapter {
  agentId: string;
  agentName: string;
  /** Find this agent's transcript files under the archive root (mirror + .versions). */
  discover(archiveRoot: string): SourceFile[];
  /** Parse one already-JSON-parsed transcript line. Return {} to skip the line. */
  parseLine(raw: unknown, file: SourceFile, seq: number): ParsedLine;
}
