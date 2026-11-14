/**
 * The source-adapter contract. The normalized DB **row shapes** now live in `@agent-lens/contracts`
 * (a pure-types leaf so the browser `web` package can share them without pulling Node code — ADR-024);
 * they are re-exported here so `@agent-lens/core` importers keep their existing import paths. The
 * adapter-seam types below stay in core because they are the ingest boundary, not consumed by web.
 */

export type {
  SourceRow,
  ProjectRow,
  SessionRow,
  TurnRow,
  EventRow,
  TokenUsageRow,
  ToolCallRow,
  SkillRow,
  ClassificationRow,
  PermissionDecision,
  PermissionVia,
} from "@agent-lens/contracts";

import type { EventRow, PermissionDecision, TokenUsageRow, ToolCallRow } from "@agent-lens/contracts";

/** Patch applied to a previously-seen tool_call once its result line arrives. */
export interface ToolResultPatch {
  tool_use_id: string;
  status?: string | null;
  agent_type?: string | null;
  /** for Task/Agent results: the spawned subagent session id, 'agent-'||toolUseResult.agentId */
  spawned_session_id?: string | null;
  /** for Workflow results: the run id (toolUseResult.runId) and workflow name, used to group + link fan-out */
  workflow_run_id?: string | null;
  workflow_name?: string | null;
  resolved_model?: string | null;
  total_duration_ms?: number | null;
  total_tokens?: number | null;
  total_tool_use_count?: number | null;
  result_summary?: string | null;
  /** How the call was approved (ADR-040); omit when the source recorded nothing. */
  permission?: PermissionDecision | null;
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
  /** This session handed off to that one (a `continued-in` line); ADR-038. */
  continued_in_session_id?: string;
}

/** A pull/merge request a line says the session touched (ADR-041). `repository` is `owner/repo`
 * (GitLab: the full group path); null when the line names only a number, which the pipeline then
 * resolves against the session's other refs. `url` is only ever an http(s) URL. */
export interface PrRef {
  repository: string | null;
  number: number;
  url: string | null;
  /** what the agent did to it (created, edited, closed, merged, commented), when recorded */
  action: string | null;
  at: string | null;
}

/** Git activity a line records. Unlike `meta`, a session accumulates many of these. */
export interface GitRefs {
  prs?: PrRef[];
  pushed_branches?: { branch: string; at: string | null }[];
}

/** What an adapter produces for a single raw transcript line. */
export interface ParsedLine {
  event?: EventRow;
  tokenUsage?: TokenUsageRow;
  toolCalls?: ToolCallRow[];
  toolResults?: ToolResultPatch[];
  meta?: SessionMeta;
  gitRefs?: GitRefs;
}

/** A transcript file discovered in the archive. */
export interface SourceFile {
  path: string;
  sessionId: string;
  encodedDir: string;
  /** true if from .versions/<ts>/ (a divergence/compaction backup) rather than the mirror */
  isVersion: boolean;
  /** the configured source (label) this file belongs to; set by the ingester */
  sourceId: string;
  /**
   * For a subagent transcript, the parent session id derived from its directory location
   * (the segment before `subagents/`); null for a main session. The deterministic structural
   * link used to attribute workflow fan-out (which carries no toolUseResult.agentId).
   */
  parentSessionId?: string | null;
  /**
   * For a Workflow-tool subagent, the run id from its path (`subagents/workflows/<runId>/…`,
   * e.g. `wf_ab787f1c-ff7`); null otherwise. Groups a run's fan-out and ties it to the launching
   * Workflow tool_call (whose result carries the same runId).
   */
  workflowRunId?: string | null;
}

/**
 * A source adapter knows how to find and parse one agent's traces. Claude Code is the first;
 * other agents add a new adapter without touching the schema.
 */
export interface SourceAdapter {
  agentId: string;
  agentName: string;
  /** Find this agent's transcript files under a source's archive dir (mirror + .versions). */
  discover(sourceArchiveDir: string, sourceId: string): SourceFile[];
  /** Parse one already-JSON-parsed transcript line. Return {} to skip the line. */
  parseLine(raw: unknown, file: SourceFile, seq: number): ParsedLine;
}
