/** Render a session to Markdown — shared by the export endpoint (ADR: data exportable as markdown). */

export interface MarkdownSession {
  id: string;
  title: string | null;
  source: string | null;
  project: string | null;
  model: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface MarkdownToolCall {
  tool_name: string;
  skill_name: string | null;
  agent_type: string | null;
  input_json: string | null;
  status: string | null;
}

export interface MarkdownEvent {
  type: string;
  role: string | null;
  timestamp: string | null;
  text: string | null;
  thinking: string | null;
  toolCalls: MarkdownToolCall[];
}

function fence(s: string): string {
  return s.length > 2000 ? s.slice(0, 2000) + "\n… (truncated)" : s;
}

export function sessionToMarkdown(s: MarkdownSession, events: MarkdownEvent[]): string {
  const out: string[] = [];
  out.push(`# ${s.title || "Session " + s.id.slice(0, 8)}`);
  out.push("");
  const meta = [
    ["Session", s.id],
    ["Source", s.source],
    ["Project", s.project],
    ["Model", s.model],
    ["Started", s.started_at],
    ["Ended", s.ended_at],
  ].filter(([, v]) => v);
  for (const [k, v] of meta) out.push(`- **${k}:** ${v}`);
  out.push("");
  out.push("---");
  out.push("");

  for (const e of events) {
    const who = e.role || e.type;
    const ts = e.timestamp ? ` _(${e.timestamp})_` : "";
    if (e.thinking) {
      out.push(`### 🧠 thinking${ts}`);
      out.push("");
      out.push(fence(e.thinking));
      out.push("");
    }
    if (e.text) {
      const icon = who === "user" ? "👤" : who === "assistant" ? "🤖" : "⚙️";
      out.push(`### ${icon} ${who}${ts}`);
      out.push("");
      out.push(fence(e.text));
      out.push("");
    }
    for (const tc of e.toolCalls) {
      const label = tc.skill_name
        ? `Skill: ${tc.skill_name}`
        : tc.agent_type
          ? `${tc.tool_name} → ${tc.agent_type}`
          : tc.tool_name;
      const status = tc.status ? ` _(${tc.status})_` : "";
      out.push(`> 🔧 **${label}**${status}`);
      if (tc.input_json && tc.input_json !== "{}") {
        out.push("```json");
        out.push(fence(tc.input_json));
        out.push("```");
      }
      out.push("");
    }
  }
  return out.join("\n");
}
