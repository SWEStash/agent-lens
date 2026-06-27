export async function api<T = any>(path: string): Promise<T> {
  const r = await fetch("/api" + path);
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
}

export interface ToolCall {
  tool_name: string;
  skill_name: string | null;
  agent_type: string | null;
  spawned_session_id: string | null;
  status: string | null;
  total_duration_ms: number | null;
  input_json: string | null;
  result_summary: string | null;
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
}

export interface SessionDetail {
  session: any;
  turns: any[];
  events: EventNode[];
  classification: Classification | null;
  parent: SessionParent | null;
  children: SessionChild[];
}

export interface TokenSplit {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
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
  subagent_fanout: {
    by_type: Array<{ type: string; n: number }>;
    sessions_with_subagents: number;
    total_spawns: number;
    max_per_session: number;
    avg_per_session: number;
  };
}
