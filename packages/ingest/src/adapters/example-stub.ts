import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  ParsedLine,
  SourceAdapter,
  SourceFile,
  ToolCallRow,
} from "@agent-lens/core";

/**
 * Example second-agent adapter — a COMPILE-TIME PROOF of the extensibility seam (ADR-008).
 *
 * This is intentionally NOT registered in `adapterList` (packages/ingest/src/index.ts) and is never
 * run. Its only job is to demonstrate that a *genuinely different* agent — different on-disk layout,
 * different transcript envelope, different tool-call shape — maps onto the same agent-agnostic
 * normalized rows (`EventRow`, `TokenUsageRow`, `ToolCallRow`) and the same `SourceAdapter` contract
 * with ZERO changes to `packages/core` (types or `schema.ts`). If the interface had leaked any
 * Claude-Code assumption, this file would not type-check against it.
 *
 * To turn a stub like this into a real adapter: (1) implement `discover`/`parseLine` for the agent's
 * real format, (2) add `new ExampleStubAdapter()` to `adapterList`, (3) add a source with the
 * matching `agent` value to `agent-lens.config.json`. No DDL.
 *
 * CAVEAT (ADR-007): this seam covers ingest/parse only. *Collection* (`scripts/collect.sh`) still
 * assumes the Claude-Code layout (`projects/**.jsonl`, `history.jsonl`, `settings`). A real second
 * agent whose files live elsewhere also needs per-agent collection logic — out of scope for the seam.
 *
 * Hypothetical "Example Agent" format (deliberately unlike Claude Code, to exercise the seam):
 *   archive layout : <source>/logs/<sessionId>.ndjson   (vs Claude Code's projects/<dir>/<id>.jsonl)
 *   line envelope  : { id, parent, role, text, ts, model, workdir, usage?, tools?[] }
 *   tool shape     : tools: [{ call_id, name, args }]   (a flat array, not content blocks)
 */
export class ExampleStubAdapter implements SourceAdapter {
  agentId = "example-stub";
  agentName = "Example Agent (stub — not wired)";

  discover(sourceArchiveDir: string, sourceId: string): SourceFile[] {
    const files: SourceFile[] = [];
    // Different layout from Claude Code: a flat `logs/` dir of *.ndjson, not `projects/<dir>/`.
    const logsDir = join(sourceArchiveDir, "logs");
    let entries;
    try {
      entries = readdirSync(logsDir, { withFileTypes: true });
    } catch {
      return files; // no logs yet for this source
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".ndjson")) continue;
      files.push({
        path: join(logsDir, e.name),
        sessionId: basename(e.name, ".ndjson"),
        encodedDir: "", // this agent has no per-project encoding; the column is nullable
        isVersion: false,
        sourceId,
      });
    }
    return files;
  }

  parseLine(raw: unknown, file: SourceFile, seq: number): ParsedLine {
    if (!raw || typeof raw !== "object") return {};
    const r = raw as Record<string, any>;

    // This agent puts cwd/model on each line rather than in a separate envelope/pointer line.
    const meta: ParsedLine["meta"] = {};
    if (typeof r.workdir === "string" && r.workdir) meta.cwd = r.workdir;

    if (typeof r.id !== "string" || !r.id) return { meta }; // lines without a stable id: metadata only

    const result: ParsedLine = {
      meta,
      event: {
        uuid: r.id, // this agent's per-line id IS our dedup key — same role as Claude Code's `uuid`
        session_id: file.sessionId,
        turn_id: null,
        parent_uuid: typeof r.parent === "string" ? r.parent : null,
        seq,
        type: typeof r.role === "string" ? r.role : "unknown",
        role: typeof r.role === "string" ? r.role : null,
        timestamp: typeof r.ts === "string" ? r.ts : null,
        model: typeof r.model === "string" ? r.model : null,
        is_sidechain: 0,
        is_meta: 0,
        text: typeof r.text === "string" ? r.text.trim() || null : null,
        raw_json: JSON.stringify(raw), // always preserve the line verbatim for lossless re-derivation
        source_file: file.path,
      },
    };

    // Token usage, if this agent reports it (note its keys differ from Claude Code's `usage`).
    const u = r.usage as Record<string, any> | undefined;
    if (u) {
      result.tokenUsage = {
        event_uuid: r.id,
        session_id: file.sessionId,
        turn_id: null,
        message_id: null, // this agent has no response-id grain — dedup falls back to event_uuid
        model: typeof r.model === "string" ? r.model : null,
        input_tokens: Number(u.prompt) || 0,
        output_tokens: Number(u.completion) || 0,
        cache_creation_input_tokens: 0, // this agent has no cache accounting — still fits the row
        cache_read_input_tokens: 0,
        service_tier: null,
      };
    }

    // Tool calls arrive as a flat array here, not as content blocks — the normalized row is identical.
    if (Array.isArray(r.tools)) {
      const toolCalls: ToolCallRow[] = [];
      for (const t of r.tools) {
        if (!t || typeof t !== "object" || typeof t.call_id !== "string") continue;
        toolCalls.push({
          id: t.call_id,
          event_uuid: r.id,
          session_id: file.sessionId,
          turn_id: null,
          tool_name: typeof t.name === "string" ? t.name : "unknown",
          caller: null,
          skill_name: null,
          agent_type: null,
          spawned_session_id: null,
          workflow_run_id: null,
          workflow_name: null,
          resolved_model: null,
          status: null,
          total_duration_ms: null,
          total_tokens: null,
          total_tool_use_count: null,
          input_json: t.args != null ? JSON.stringify(t.args) : null,
          result_summary: null,
        });
      }
      if (toolCalls.length) result.toolCalls = toolCalls;
    }

    return result;
  }
}
