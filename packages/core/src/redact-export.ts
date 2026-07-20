/**
 * Redacted, export-only sharing (backlog #3). Produces a sanitized Markdown artifact the user
 * shares MANUALLY — no network, no upload, no server-side link. Distinct from the corpus Redactor
 * (packages/ingest/src/redact.ts), which is deny-by-default for a metric-preserving test corpus and
 * would scrub a share into a wall of "[redacted]". Here the default keeps the narrative readable and
 * masks only secrets/PII, with a fail-closed post-render scan; `structure` is the aggressive scrub;
 * `off` is the explicit verbatim opt-out.
 *
 * Redaction is BEST-EFFORT / pattern-based, not a guarantee — the emitted header says so.
 */
import { createHash } from "node:crypto";
import { sessionToMarkdown, type MarkdownSession, type MarkdownEvent } from "./markdown.js";
import { maskSecrets, findLeak, deriveHomeUsers, scrubUsernames, LEAK_PATTERNS, SHARE_LEAK, type LeakPattern } from "./secrets.js";

export type RedactionLevel = "secrets" | "structure";
export interface ExportOptions {
  level?: RedactionLevel | "off";
}
export interface ExportResult {
  markdown: string;
  /** True if the fail-closed post-render scan had to catch a leak the field pass missed. */
  residualLeak: boolean;
  level: RedactionLevel | "off";
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 4);
}

/** Aggressive path pseudonymization for the `structure` level (home username still stripped). */
function structurePath(p: string | null): string | null {
  if (!p) return p;
  const abs = p.startsWith("/");
  const segs = p.split("/").filter(Boolean);
  const out = segs.map((seg, i) => {
    if (segs[i - 1] === "home" || segs[i - 1] === "Users") return "user";
    if (seg === "home" || seg === "Users") return seg;
    const last = i === segs.length - 1;
    const dot = last ? seg.lastIndexOf(".") : -1;
    return dot > 0 ? `file-${hash(seg)}${seg.slice(dot)}` : `dir-${hash(seg)}`;
  });
  return (abs ? "/" : "") + out.join("/");
}

/** Replace narrative text with a placeholder, preserving null/empty. */
function scrub(s: string | null): string | null {
  return s && s.length > 0 ? "[redacted]" : s;
}

/** Apply the chosen redaction policy to the export data model, returning fresh copies. */
export function redactSession(
  session: MarkdownSession,
  events: MarkdownEvent[],
  level: RedactionLevel,
): { session: MarkdownSession; events: MarkdownEvent[] } {
  // Derive the session's home-dir owner(s) from ALL raw fields, so a bare username in a github URL
  // or prose (no path form) is scrubbed too. Done pre-masking, before /home/<u>/ becomes /home/user/.
  const users = deriveHomeUsers([
    session.title, session.project, session.source,
    ...events.flatMap((e) => [e.text, e.thinking, ...e.toolCalls.map((t) => t.input_json)]),
  ]);
  const unuser = (s: string | null) => (s == null ? s : scrubUsernames(s, users));

  if (level === "structure") {
    return {
      session: { ...session, title: session.title ? "Redacted session" : session.title, project: structurePath(session.project), source: unuser(session.source) },
      events: events.map((e) => ({
        ...e,
        text: scrub(e.text),
        thinking: scrub(e.thinking),
        toolCalls: e.toolCalls.map((t) => ({ ...t, input_json: t.input_json ? "{}" : t.input_json })),
      })),
    };
  }
  // "secrets": selective masking, narrative preserved.
  const mask = (s: string | null) => (s == null ? s : scrubUsernames(maskSecrets(s), users));
  return {
    session: { ...session, title: mask(session.title), project: mask(session.project), source: mask(session.source) },
    events: events.map((e) => ({
      ...e,
      text: mask(e.text),
      thinking: mask(e.thinking),
      toolCalls: e.toolCalls.map((t) => ({ ...t, input_json: mask(t.input_json) })),
    })),
  };
}

/** Global replace of any scan-set match with [REDACTED]; reports whether anything was caught. */
function sweep(md: string, patterns: LeakPattern[]): { md: string; caught: boolean } {
  let out = md;
  let caught = false;
  for (const { re } of patterns) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    if (g.test(out)) {
      caught = true;
      out = out.replace(g, "[REDACTED]");
    }
  }
  return { md: out, caught };
}

function disclaimer(level: RedactionLevel): string {
  return (
    `> 🔒 **Redacted export** (level: ${level}) — best-effort automatic masking of secrets, tokens, ` +
    `emails, IPs, and usernames. Not a guarantee; review before sharing. Generated locally by ` +
    `Agent Lens — never uploaded.`
  );
}

/**
 * Render a session to a shareable Markdown artifact. The single entry point used by the server
 * endpoint and the CLI. For redacted levels: redact fields → render → fail-closed sweep →
 * prepend the disclaimer.
 */
export function exportMarkdown(session: MarkdownSession, events: MarkdownEvent[], opts: ExportOptions = {}): ExportResult {
  const level = opts.level ?? "secrets";
  if (level === "off") {
    return { markdown: sessionToMarkdown(session, events), residualLeak: false, level: "off" };
  }
  const redacted = redactSession(session, events, level);
  const rendered = sessionToMarkdown(redacted.session, redacted.events);
  const scanSet = level === "structure" ? LEAK_PATTERNS : SHARE_LEAK;
  const { md, caught } = sweep(rendered, scanSet);
  return { markdown: `${disclaimer(level)}\n\n${md}`, residualLeak: caught, level };
}

export { maskSecrets, findLeak };
