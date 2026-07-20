/**
 * Agent Lens — metric-preserving transcript redactor (validation Layer 4).
 *
 * Produces a privacy-safe corpus that is realistic enough to validate the whole compute pipeline
 * end-to-end, by an explicit contract:
 *
 *   PRESERVE (so metrics are identical to the raw input): uuid, parentUuid, type, timestamp,
 *   isSidechain, isMeta, agentId (opaque hex, drives subagent linkage), message.{role,id,model,
 *   usage,stop_reason}, toolUseResult numeric/linkage fields, tool_use {id,name}, and — crucially —
 *   the *line count* of Edit/Write payloads + the *distinctness & extension* of file paths (these
 *   feed the LoC / files complexity sub-scores).
 *
 *   REDACT (deny-by-default): all message text/thinking, tool_result content, cwd & file paths
 *   (pseudonymized, usernames stripped), slug/aiTitle/gitBranch, and any other free text. Stable
 *   irreversible pseudonyms keep joins/counts intact (same input → same pseudonym).
 *
 * Token accounting, cost, durations, counts, subagent linkage, and the complexity *score* are
 * therefore identical between raw and redacted. The classifier *category* is text-derived and is
 * NOT preserved (validated separately by golden fixtures) — callers must exclude it from oracle
 * equality checks.
 *
 * HARD RULES (see memory test-corpus-redaction): never emit data from the agent-lens project
 * itself; scrub project names, paths, users, hosts, secrets. The CLI filters agent-lens sessions
 * and runs a final leak-scan before writing.
 */
import { createHash, randomBytes } from "node:crypto";
import { parseSkillInjection } from "./pipeline.js";

const PLACEHOLDER = "[redacted]";

/** Lines in a string, matching classify.ts/countLines exactly (trailing newline doesn't add a line). */
function countLines(s: unknown): number {
  if (typeof s !== "string" || s.length === 0) return 0;
  const trimmed = s.endsWith("\n") ? s.slice(0, -1) : s;
  return trimmed.length === 0 ? 0 : trimmed.split("\n").length;
}
/** A dummy string whose countLines() == n (so LoC sub-scores are preserved). */
function dummyLines(n: number): string {
  return n <= 0 ? "" : Array(n).fill("x").join("\n");
}

export class Redactor {
  private cache = new Map<string, string>();
  constructor(private salt: string = randomBytes(8).toString("hex")) {}

  private hash(s: string, n = 6): string {
    return createHash("sha256").update(this.salt).update(s).digest("hex").slice(0, n);
  }
  private stable(kind: string, s: string): string {
    const key = `${kind}:${s}`;
    let v = this.cache.get(key);
    if (!v) {
      v = `${kind}-${this.hash(key)}`;
      this.cache.set(key, v);
    }
    return v;
  }

  /** Pseudonymize a path: strip the user's home, pseudonymize each segment, keep depth + extension. */
  path(p: unknown): string | null {
    if (typeof p !== "string" || !p) return typeof p === "string" ? p : null;
    const abs = p.startsWith("/");
    const segs = p.split("/").filter(Boolean);
    const out: string[] = [];
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      // Drop the "<user>" right after a home root so usernames never survive.
      if ((segs[i - 1] === "home" || segs[i - 1] === "Users") && i >= 1) {
        out.push("user");
        continue;
      }
      if (seg === "home" || seg === "Users") {
        out.push(seg);
        continue;
      }
      const last = i === segs.length - 1;
      const dot = last ? seg.lastIndexOf(".") : -1;
      if (dot > 0) out.push(`file-${this.hash(seg)}${seg.slice(dot)}`); // keep extension
      else out.push(this.stable("dir", seg));
    }
    return (abs ? "/" : "") + out.join("/");
  }

  /** Pseudonymize a free-form identifier (slug, label, branch). */
  ident(kind: string, s: unknown): string {
    return typeof s === "string" && s ? this.stable(kind, s) : `${kind}-none`;
  }

  /** Replace free text with a placeholder, PRESERVING emptiness (turn detection depends on it). */
  private text(s: unknown): string {
    return typeof s === "string" && s.length > 0 ? PLACEHOLDER : "";
  }

  /**
   * Preserve a skill-body injection ("Base directory for this skill: …\n\n<SKILL.md body>\n\nARGUMENTS:…")
   * instead of redacting it — the body is the only real skill content and drives version tracking.
   * We strip the per-call ARGUMENTS block, replace the home-path base-dir line with a non-leaking
   * `/skills/<name>` (keeping the skill-name tail so ingest still links it), keep the body verbatim,
   * and fail closed: if the result trips the leak scan, return null so the caller fully redacts it.
   * Returns null when `s` is not a skill injection.
   */
  private skillText(s: unknown): string | null {
    if (typeof s !== "string") return null;
    const inj = parseSkillInjection(s);
    if (!inj) return null;
    const nameTail = (inj.baseDir ?? "").split("/").filter(Boolean).pop() ?? "";
    const rebuilt = `Base directory for this skill: /skills/${nameTail}\n\n${inj.body}\n`;
    return findLeak(rebuilt) ? null : rebuilt;
  }

  private toolInput(name: string, input: any): any {
    if (!input || typeof input !== "object") return {};
    const out: any = {};
    // Skill name (skill_name metric); only the Skill tool's command is non-sensitive enough to keep.
    if (typeof input.skill === "string") out.skill = input.skill;
    if (name === "Skill" && typeof input.command === "string") out.command = input.command;
    // Subagent type (agent_type metric).
    if ((name === "Task" || name === "Agent") && typeof input.subagent_type === "string") out.subagent_type = input.subagent_type;
    // LoC-bearing payloads: keep line counts + a pseudonymized path with its extension.
    if (name === "Write") {
      out.file_path = this.path(input.file_path);
      out.content = dummyLines(countLines(input.content));
    } else if (name === "Edit") {
      out.file_path = this.path(input.file_path);
      out.old_string = dummyLines(countLines(input.old_string));
      out.new_string = dummyLines(countLines(input.new_string));
    }
    return out;
  }

  private block(b: any): any {
    if (!b || typeof b !== "object") return b;
    switch (b.type) {
      case "text":
        return { type: "text", text: this.skillText(b.text) ?? this.text(b.text) };
      case "thinking":
        return { type: "thinking", thinking: this.text(b.thinking) };
      case "tool_use":
        return { type: "tool_use", id: b.id, name: b.name, input: this.toolInput(String(b.name), b.input), ...(b.caller ? { caller: b.caller } : {}) };
      case "tool_result":
        return { type: "tool_result", tool_use_id: b.tool_use_id, content: PLACEHOLDER, ...(b.is_error ? { is_error: true } : {}) };
      default:
        return { type: b.type };
    }
  }

  private message(m: any): any {
    if (!m || typeof m !== "object") return m;
    const out: any = {};
    for (const k of ["role", "id", "model", "type", "usage", "stop_reason", "stop_sequence"]) if (k in m) out[k] = m[k];
    if (typeof m.content === "string") out.content = this.skillText(m.content) ?? this.text(m.content);
    else if (Array.isArray(m.content)) out.content = m.content.map((b: any) => this.block(b));
    return out;
  }

  /** Redact one parsed transcript line (object). */
  line(r: any): any {
    if (!r || typeof r !== "object") return r;
    const out: any = {};
    // Structural / metric-bearing scalars kept verbatim.
    for (const k of ["uuid", "parentUuid", "type", "timestamp", "isSidechain", "isMeta", "agentId", "userType", "version"]) if (k in r) out[k] = r[k];
    if (typeof r.cwd === "string") out.cwd = this.path(r.cwd);
    if (typeof r.gitBranch === "string") out.gitBranch = this.ident("branch", r.gitBranch);
    if (typeof r.slug === "string") out.slug = this.ident("slug", r.slug);
    if (r.type === "ai-title") out.aiTitle = "Redacted session";
    if (r.toolUseResult && typeof r.toolUseResult === "object") {
      const t = r.toolUseResult;
      const tu: any = {};
      for (const k of ["status", "agentType", "agentId", "resolvedModel", "totalDurationMs", "totalTokens", "totalToolUseCount"]) if (k in t) tu[k] = t[k];
      out.toolUseResult = tu;
    }
    if ("message" in r) out.message = this.message(r.message);
    return out;
  }

  /** Redact a whole JSONL transcript (string in, string out). Malformed lines are dropped. */
  transcript(content: string): string {
    const lines: string[] = [];
    for (const raw of content.split("\n")) {
      if (!raw.trim()) continue;
      let obj: any;
      try {
        obj = JSON.parse(raw);
      } catch {
        continue;
      }
      lines.push(JSON.stringify(this.line(obj)));
    }
    return lines.join("\n") + "\n";
  }
}

// Canonical Claude Code project-dir encoder now lives in core so collect + ingest agree exactly.
export { encodeProjectPath } from "@agent-lens/core";
import { encodeProjectPath } from "@agent-lens/core";
// The fail-closed leak scan now lives in core (shared with the redacted-export sanitizer). Re-export
// so this module's consumers (redact-cli.ts, tests) keep their `./redact.js` import unchanged.
export { LEAK_PATTERNS, findLeak } from "@agent-lens/core";
import { findLeak } from "@agent-lens/core";

/** Parse the AGENT_LENS_REDACT_EXCLUDE CSV of real project paths into encoded-dir prefixes. */
export function parseExcludes(csv: string | undefined | null): string[] {
  return (csv ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(encodeProjectPath);
}

/** True if `encodedDir` is (or sits under) any excluded project path — used to keep data out of the corpus. */
export function isExcludedDir(encodedDir: string, excluded: string[]): boolean {
  return excluded.some((e) => encodedDir === e || encodedDir.startsWith(e + "-"));
}

/**
 * True if an archive file path belongs to an excluded project. Matches the `/projects/<encodedDir>/`
 * segment, so it catches both the main transcript AND its nested `<UUID>/subagents/agent-*.jsonl`.
 * `excluded` is the encoded-dir list from parseExcludes().
 */
export function isExcludedArchivePath(filePath: string, excluded: string[]): boolean {
  return excluded.some((e) => filePath.includes(`/projects/${e}/`));
}
