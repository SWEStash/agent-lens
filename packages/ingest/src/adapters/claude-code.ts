import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  ParsedLine,
  SourceAdapter,
  SourceFile,
  ToolCallRow,
  ToolResultPatch,
} from "@agent-lens/core";

/** Flatten a message `content` (string or block array) to searchable natural-language text. */
function flattenText(content: unknown): string | null {
  if (content == null) return null;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "thinking" && typeof b.thinking === "string") parts.push(b.thinking);
  }
  const text = parts.join("\n").trim();
  return text || null;
}

/** Short, single-line summary of a tool result (kept small to avoid dumping large/secret output). */
function summarizeResult(content: unknown): string | null {
  let s: string | null = null;
  if (typeof content === "string") s = content;
  else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
    s = parts.join("\n");
  } else if (content != null) {
    s = JSON.stringify(content);
  }
  if (!s) return null;
  s = s.replace(/\s+/g, " ").trim();
  return s.slice(0, 280) || null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asInt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
}

function recurseJsonl(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) recurseJsonl(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
}

export class ClaudeCodeAdapter implements SourceAdapter {
  agentId = "claude-code";
  agentName = "Claude Code CLI";

  discover(archiveRoot: string): SourceFile[] {
    const files: SourceFile[] = [];

    const addFrom = (projectsDir: string, isVersion: boolean) => {
      const found: string[] = [];
      recurseJsonl(projectsDir, found);
      for (const path of found) {
        // <...>/projects/<encodedDir>/<sessionId>.jsonl
        const parts = path.split("/");
        const sessionId = basename(path, ".jsonl");
        const encodedDir = parts[parts.length - 2] ?? "";
        files.push({ path, sessionId, encodedDir, isVersion });
      }
    };

    addFrom(join(archiveRoot, "projects"), false);

    // .versions/<ts>/projects/<encodedDir>/<sessionId>.jsonl
    const versionsRoot = join(archiveRoot, ".versions");
    try {
      for (const ts of readdirSync(versionsRoot, { withFileTypes: true })) {
        if (ts.isDirectory()) addFrom(join(versionsRoot, ts.name, "projects"), true);
      }
    } catch {
      /* no versions yet */
    }
    return files;
  }

  parseLine(raw: unknown, file: SourceFile, seq: number): ParsedLine {
    if (!raw || typeof raw !== "object") return {};
    const r = raw as Record<string, any>;

    // Session-level metadata from the common envelope + pointer lines.
    const meta: ParsedLine["meta"] = {};
    if (asString(r.cwd)) meta.cwd = r.cwd;
    if (asString(r.slug)) meta.slug = r.slug;
    if (asString(r.version)) meta.cli_version = r.version;
    if (asString(r.entrypoint)) meta.entrypoint = r.entrypoint;
    if (asString(r.gitBranch)) meta.git_branch = r.gitBranch;
    if (typeof r.isSidechain === "boolean") meta.is_sidechain = r.isSidechain;
    if (r.type === "ai-title" && asString(r.aiTitle)) meta.ai_title = r.aiTitle;

    // Lines without a uuid (pointer/meta lines) contribute metadata only.
    if (!asString(r.uuid)) return { meta };

    const message = (r.message ?? {}) as Record<string, any>;
    const text = flattenText(message.content);

    const result: ParsedLine = {
      meta,
      event: {
        uuid: r.uuid,
        session_id: file.sessionId,
        turn_id: null,
        parent_uuid: asString(r.parentUuid),
        seq,
        type: asString(r.type) ?? "unknown",
        role: asString(message.role),
        timestamp: asString(r.timestamp),
        model: asString(message.model),
        is_sidechain: r.isSidechain ? 1 : 0,
        is_meta: r.isMeta ? 1 : 0,
        text,
        raw_json: JSON.stringify(raw),
        source_file: file.path,
      },
    };

    // Token usage at the assistant-message grain.
    const usage = message.usage as Record<string, any> | undefined;
    if (usage) {
      result.tokenUsage = {
        event_uuid: r.uuid,
        session_id: file.sessionId,
        turn_id: null,
        model: asString(message.model),
        input_tokens: asInt(usage.input_tokens),
        output_tokens: asInt(usage.output_tokens),
        cache_creation_input_tokens: asInt(usage.cache_creation_input_tokens),
        cache_read_input_tokens: asInt(usage.cache_read_input_tokens),
        service_tier: asString(usage.service_tier),
      };
    }

    // Tool calls (tool_use blocks) and tool results (tool_result blocks + toolUseResult).
    const content = message.content;
    if (Array.isArray(content)) {
      const toolCalls: ToolCallRow[] = [];
      const toolResults: ToolResultPatch[] = [];
      const tur = r.toolUseResult as Record<string, any> | undefined;

      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, any>;

        if (b.type === "tool_use" && asString(b.id)) {
          const name = asString(b.name) ?? "unknown";
          const input = b.input ?? {};
          toolCalls.push({
            id: b.id,
            event_uuid: r.uuid,
            session_id: file.sessionId,
            turn_id: null,
            tool_name: name,
            caller: asString(b.caller),
            skill_name: name === "Skill" ? asString(input.skill) ?? asString(input.command) : null,
            agent_type:
              name === "Task" || name === "Agent" ? asString(input.subagent_type) : null,
            resolved_model: null,
            status: null,
            total_duration_ms: null,
            total_tokens: null,
            total_tool_use_count: null,
            input_json: JSON.stringify(input),
            result_summary: null,
          });
        } else if (b.type === "tool_result" && asString(b.tool_use_id)) {
          toolResults.push({
            tool_use_id: b.tool_use_id,
            result_summary: summarizeResult(b.content),
            ...(tur
              ? {
                  status: asString(tur.status),
                  agent_type: asString(tur.agentType),
                  resolved_model: asString(tur.resolvedModel),
                  total_duration_ms: typeof tur.totalDurationMs === "number" ? tur.totalDurationMs : null,
                  total_tokens: typeof tur.totalTokens === "number" ? tur.totalTokens : null,
                  total_tool_use_count:
                    typeof tur.totalToolUseCount === "number" ? tur.totalToolUseCount : null,
                }
              : {}),
          });
        }
      }
      if (toolCalls.length) result.toolCalls = toolCalls;
      if (toolResults.length) result.toolResults = toolResults;
    }

    return result;
  }
}
