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
  cost: number;
}

export interface ToolCall {
  tool_name: string;
  skill_name: string | null;
  agent_type: string | null;
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

export interface SessionDetail {
  session: any;
  turns: any[];
  events: EventNode[];
}
