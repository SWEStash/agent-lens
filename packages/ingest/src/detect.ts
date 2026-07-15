/**
 * Agent Lens — security findings (ADR-017). No AI: risky operations are flagged deterministically
 * by a rule engine over signals already in the DB (each tool call's verbatim `input_json` /
 * `result_summary` / `status`, plus the session's project path). Re-runnable and idempotent — the
 * same DB always yields identical rows. Every matched pattern and context modifier is recorded in
 * `signals_json` so a finding can be explained and rules retuned without re-deriving meaning.
 *
 * agent-lens is a *retrospective* analyzer, so this is forensic awareness — surfacing that an agent
 * *did* something risky after the fact — not runtime prevention. Findings are 0..N per tool call, so
 * an incremental re-run DELETEs the touched sessions' rows then re-INSERTs (delete-then-insert),
 * unlike the 1-per-session `classifications` upsert. `detector_version` lets a future (e.g. local-LLM)
 * engine supersede these rows.
 */
import { createHash } from "node:crypto";
import { bumpSeverity, type Severity, type SecurityCategoryKey } from "@agent-lens/core";
import type { DB } from "./db.js";

// Bump on any rule/severity change so a re-run is attributable to an engine version (mirrors
// CLASSIFIER_VERSION). Recorded on every row + in signals_json. v2: allowlist agent-owned paths so
// the agent writing to its own config/work dir (e.g. a plan file under ~/.claude/plans) or a temp dir
// is not flagged as an out-of-project write. v3: exclude .env.example / config templates from
// credential-access, require a real content-read verb (ls/file/stat no longer flag), raise `sudo` to
// high. v4: fix template exclusion when the path is followed by shell text (.env.example | …); score
// secret reads per pipeline segment so `file/ls … | grep` no longer counts as a content read; derive
// the agent-owned config roots from the configured sources' `config_dir` (covers ~/.claude-isf and
// any relocated install) instead of a hardcoded `.claude` pattern. v5: match command-pattern rules
// against an "executed view" of the command (codeOf — comments stripped, echo/printf output
// neutralized) so a dangerous token that is only printed, commented, quoted (`node -e '… sudo …'`,
// `grep "sudo"`), or inside a heredoc body no longer flags; scope `sudo` to command position (ignores
// `apt install sudo`); add privilege.exec_generated_script for the write-a-script-then-run-it pattern
// that makes echoed/heredoc'd text live. v6: exfil.network_upload scores curl/wget uploads by
// destination scope instead of always-high — external host = high (critical with a file), private/
// internal host (RFC1918 / link-local / .local / bare service name) = low, loopback = info; a real file
// (@file / -T / --upload-file) bumps the internal/loopback tiers one step. The host is classified on the
// verbatim command (commandBare blanks quoted URLs, hiding the host) with -H/--header args stripped so a
// URL in an Origin/Referer header can't pose as the target; and the upload-flag match is now case-
// SENSITIVE so curl's -D/-f/-t (dump-header/fail/…) no longer read as -d/-F/-T uploads. v6 also re-tiers
// several routine ops out of the crowded medium bucket: write_outside_project (non-system) and
// git_reset_hard / non-protected git_force_push drop to low, and overwrite_critical splits — lockfile
// churn is low while a CI-config overwrite stays medium (poisoned pipeline is a supply-chain risk);
// system-path writes and protected-branch force-push keep their high. And curl_pipe_shell no longer
// flags `curl … | node -e`/`python -c`/`python -m` (the interpreter runs inline code and the piped
// output is just data, e.g. parsing an API response) — only a shell or a bare node/python that executes
// the downloaded body still flags. Finding ids are independent of this version, so a bump doesn't
// invalidate user triage state.
export const DETECTOR_VERSION = 6;

// Severity model + category taxonomy are shared from core (packages/core/src/security.ts) so the
// server and web agree on ordering and keys. Re-exported for tests that drive this module directly.
export { bumpSeverity, type Severity };
type Category = SecurityCategoryKey;

/** Truncate an evidence snippet so we never dump wholesale secrets/output into the DB. */
function evidence(s: string, max = 200): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

/** Deterministic finding id — stable across runs so re-detection reproduces identical rows. */
function findingId(toolCallId: string, ruleId: string): string {
  return createHash("sha1").update(toolCallId).update("\0").update(ruleId).digest("hex").slice(0, 16);
}

export interface RuleContext {
  toolName: string;
  command: string | null; // Bash command string, verbatim (for evidence + value scanning)
  commandCode: string | null; // executed view, quotes INTACT (comments/heredoc/echo-output neutralized) — for sql_drop
  commandBare: string | null; // commandCode + quoted-string contents blanked — for command-verb rules (sudo, rm, …)
  filePath: string | null; // Read/Write/Edit file_path, if any
  input: any; // parsed input_json (may be null)
  resultSummary: string | null;
  status: string | null; // success | error | ...
  projectPath: string | null; // the session's cwd, for outside-project checks
  ownedConfigDirs: string[]; // agent config roots (from the `sources` table) the agent legitimately owns
}

export interface RuleMatch {
  evidence: string; // the offending snippet
  severity?: Severity; // override the rule's baseSeverity (context-driven escalation)
  mods?: Record<string, unknown>; // extra explainability recorded in signals_json
}

interface Rule {
  id: string;
  category: Category;
  framework_ref: string;
  title: string;
  tools: string[] | "*"; // tool_names this rule applies to
  baseSeverity: Severity;
  test(ctx: RuleContext): RuleMatch | null;
}

// ---- Shared matchers ------------------------------------------------------

// A path we consider outside the agent's working project (home dotfiles, system dirs, root).
const SYSTEM_PATH = /(^|\s)(\/etc\/|\/usr\/|\/bin\/|\/sbin\/|\/boot\/|\/var\/|\/root\/|~\/\.ssh\/|~\/\.aws\/)/;
const HOME_OR_ROOT_TARGET = /(\s|^)(~\/?|\/|\/\*|\$HOME\/?|\*)(\s|$)/;

/** Secret-bearing file locations (matched against a file path or a shell command). */
const SECRET_FILE =
  /(^|\/|\s)(\.env(\.[\w.-]+)?|id_rsa|id_ed25519|id_ecdsa|\.ssh\/[\w.-]+|\.aws\/credentials|\.gcp\/|gcloud\/|\.npmrc|\.pypirc|\.netrc|\.pem|\.p12|\.pfx|secrets?\.(ya?ml|json|txt)|credentials(\.json)?)\b/i;

// Non-secret config *templates* (e.g. .env.example, secrets.sample.yaml) — reading these is expected
// and carries no real secret, so exclude them from credential-access even though they match SECRET_FILE.
// The trailing (?![\w-]) matches the end of the ".example" token whether the token ends the string
// (a Read filePath) or is followed by more shell text (`… .env.example | head`) — a plain `$` anchor
// only handled the former and let the Bash-command case slip through.
const EXAMPLE_FILE = /\.(example|sample|template|dist)(?![\w-])/i;

// Commands that read file *contents* — the actual credential-access signal. Listing/stat commands
// (ls, file, stat, find, …) are deliberately absent: naming a secret path in an `ls`/`file` doesn't
// read it, so they must not flag (only a content read does).
const CONTENT_READ_CMD = /\b(cat|less|more|head|tail|bat|xxd|strings|base64|grep|egrep|rg|awk|sed|nl|tac|od|hexdump|cp|scp|sort)\b/i;

/** Secret-looking values (in a command or a captured result). */
const SECRET_VALUE_PATTERNS: Array<{ re: RegExp; label: string; critical?: boolean }> = [
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, label: "private-key", critical: true },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: "aws-access-key-id" },
  { re: /\bASIA[0-9A-Z]{16}\b/, label: "aws-temp-key-id" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, label: "github-token" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, label: "slack-token" },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/, label: "api-secret-key" },
];

const isBash = (t: string) => t === "Bash";

// ---- Command sanitization ------------------------------------------------
// Command-pattern rules ("did the agent run a dangerous command?") must match the *executed* code,
// not text that is merely printed or commented. `codeOf()` produces that executed view:
//   • strips shell comments (`# …` never runs), and
//   • neutralizes the arguments of the print builtins echo/printf — their quoted/plain text is data
//     sent to stdout, so `sudo`/`rm -rf`/… inside it is inert. Quoted strings are consumed as whole
//     units, so separators (`;` `|`) inside a printed string never leak out as fake command breaks.
// NOTE: this intentionally does NOT blank all quoted strings — `psql -c "DROP …"`, `sh -c "…"` carry
// executed code inside quotes, which must still be detected. Value-scanning rules (secret_in_data)
// keep using the raw command, since a secret value is exposed whether or not it was "executed".
const stripComments = (c: string): string => c.replace(/(^|\s)#[^\n]*/g, "$1");
const neutralizeEcho = (c: string): string =>
  c.replace(/((?:^|[;&|\n(])\s*)(?:echo|printf)\b(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^;&|\n])*/gi, "$1echo");
// A heredoc body (`cmd <<EOF … EOF`) is data written to a file/stdin, not commands the shell runs, so a
// `sudo`/`rm -rf` line inside it is inert (unless the resulting file is then executed — see
// execGeneratedScript). Replace the whole heredoc, body included, with a placeholder.
const blankHeredoc = (c: string): string => c.replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2\b/g, "<<HEREDOC");
// `codeOf`: quotes INTACT (so `psql -c "DROP …"` — executed code inside quotes — still matches), with
// comments, heredoc bodies, and echo/printf output neutralized.
const codeOf = (c: string): string => neutralizeEcho(stripComments(blankHeredoc(c)));
// Blank the CONTENTS of quoted string literals. A dangerous token inside a quoted *argument*
// (`node -e '… sudo …'`, `grep "sudo"`, `git commit -m "… rm -rf …"`) is data passed to a program,
// not a shell command word — so the command-verb rules must not match it. (Tradeoff: a command truly
// executed via `sh -c "sudo …"` is missed; that inline form is rare and worth the far fewer false
// positives.) codeOf runs first so in-string separators are already gone from the parts we keep.
const blankQuoted = (c: string): string => c.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'[^']*'/g, "''");
const bareOf = (c: string): string => blankQuoted(codeOf(c));

// A file is "executed" when passed to an interpreter (sh/bash/…), sourced (`source`/`.`), or invoked
// as a path (`./f`, `/abs/f`). Detects the write-a-script-then-run-it pattern (`echo … > f.sh; sh f.sh`)
// that turns otherwise-inert printed text into live code. Returns the offending file, or null.
function execGeneratedScript(cmd: string): string | null {
  const targets = new Set<string>();
  for (const m of cmd.matchAll(/(?:>>?|\btee\b\s+(?:-a\s+)?)\s*["']?([A-Za-z0-9._/~-]+)/g)) {
    if (m[1] && !m[1].startsWith("/dev/")) targets.add(m[1]);
  }
  for (const t of targets) {
    const e = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Interpreter/source invocation: `sh FILE`, `bash FILE`, `source FILE`, `. FILE` (the interpreter is
    // the command word, so FILE may sit anywhere after it).
    const interp = new RegExp(`\\b(?:sh|bash|zsh|ksh|dash|source)\\s+["']?${e}\\b|(?:^|[\\n;|&(])\\s*\\.\\s+["']?${e}\\b`);
    // FILE run directly — must be at COMMAND POSITION (start or after a separator), NOT an argument slot,
    // otherwise the redirect/`tee FILE` target matches its own occurrence (`… | tee /etc/hosts`).
    const hasPath = /^(\.\/|\/|~\/)/.test(t);
    const path = hasPath
      ? new RegExp(`(?:^|[\\n;|&(])\\s*${e}(?:\\s|$|[;&|<>])`)
      : new RegExp(`(?:^|[\\n;|&(])\\s*\\.\\/${e}\\b`);
    if (interp.test(cmd) || path.test(cmd)) return t;
  }
  return null;
}

// Temp dirs (including the per-session scratchpad under /tmp/…) are always agent-owned regardless of
// which agent/config produced them.
const TEMP_PATH = /^(\/tmp\/|\/var\/folders\/|\/private\/var\/folders\/)/;

/**
 * Paths the agent legitimately owns, so writing there is expected, not a finding: its own config/work
 * dir (e.g. plans, memory, todos, projects, settings, skills) and temp dirs. The config roots are the
 * `config_dir`s of the configured sources (the `sources` table, seeded from the project config file),
 * NOT a hardcoded `.claude` pattern — that way side-by-side installs (~/.claude, ~/.claude-isf, …) and
 * any relocated config dir are covered from a single source of truth. Neutralizes the biggest
 * write_outside_project false-positive source.
 */
export function isAgentOwnedPath(p: string, configDirs: string[]): boolean {
  if (TEMP_PATH.test(p)) return true;
  if (configDirs.some((d) => p === d || p.startsWith(d + "/"))) return true;
  const tmp = process.env.TMPDIR;
  return !!tmp && p.startsWith(tmp.replace(/\/$/, "") + "/");
}

/** Does an absolute file path fall outside the session's project directory? (null-safe.) */
function outsideProject(filePath: string | null, projectPath: string | null, configDirs: string[]): boolean {
  if (!filePath || !filePath.startsWith("/")) return false; // relative paths are project-local
  if (isAgentOwnedPath(filePath, configDirs)) return false; // agent's own config/work dir + temp → expected
  if (!projectPath) return false; // unknown project → don't guess
  return filePath !== projectPath && !filePath.startsWith(projectPath.replace(/\/$/, "") + "/");
}

// Classify the destination host(s) of a curl/wget command for exfil scoring. Runs on the VERBATIM
// command (not commandBare) so quoted URLs are visible, and strips -H/--header args so a URL sitting
// in an Origin/Referer header is never mistaken for the request target. Returns the most-severe scope
// present: external > internal > loopback; "unknown" when no host is recognizable (e.g. the target is
// a shell variable) — treated as external-ish so we don't under-report an unprovable destination.
type NetScope = "external" | "internal" | "loopback" | "unknown";
const SCOPE_RANK: Record<NetScope, number> = { unknown: 0, loopback: 1, internal: 2, external: 3 };
function netTargetScope(rawCommand: string): NetScope {
  const s = rawCommand
    .replace(/(?:-H|--header)\s+(['"]).*?\1/gi, " ") // quoted header value (Origin/Referer/…)
    .replace(/(?:-H|--header)\s+[^\s'"]+/gi, " "); // bare header token
  const authorities: string[] = [];
  // scheme URLs: http(s)://host  (host may be a bracketed IPv6 literal)
  for (const m of s.matchAll(/\bhttps?:\/\/(\[[0-9a-fA-F:]+\]|[^/\s"'<>|]+)/gi)) authorities.push(m[1]);
  // bare host:port targets (curl localhost:4477, curl 10.0.0.5:8080) — require a numeric port so we
  // never mistake a file path or a `key:value` token for a network destination.
  for (const m of s.matchAll(/(?:^|[\s"'=(])(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):\d{2,5}(?=[/\s"']|$)/g)) authorities.push(m[1]);
  let scope: NetScope = "unknown";
  for (let host of authorities) {
    host = host.replace(/^\[|\]$/g, "").replace(/^[^@/]*@/, "").toLowerCase(); // drop brackets + userinfo
    if (!host.includes("::")) host = host.replace(/:\d+$/, ""); // drop :port (but not the ::1 in IPv6)
    let hs: NetScope;
    if (host === "localhost" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host === "0.0.0.0" || host === "::1")
      hs = "loopback";
    else if (
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || // RFC1918
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host) || // link-local
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      !host.includes(".") // single-label host (a service name, not a public domain)
    )
      hs = "internal";
    else hs = "external";
    if (SCOPE_RANK[hs] > SCOPE_RANK[scope]) scope = hs;
  }
  return scope;
}

// ---- The rule set (v1) ----------------------------------------------------
// Representative, not exhaustive; grouped by framework-anchored category. New rules just append here.

const RULES: Rule[] = [
  // --- Destructive / data-loss (OWASP ASI02 Tool Misuse) -------------------
  {
    id: "destructive.rm_rf",
    category: "destructive",
    framework_ref: "OWASP ASI02",
    title: "Recursive force delete (rm -rf)",
    tools: ["Bash"],
    baseSeverity: "high",
    test(ctx) {
      const c = ctx.commandBare;
      if (!c) return null;
      // rm with both a recursive and a force flag, in either order (-rf, -fr, -r -f, --recursive --force).
      const rf = /\brm\s+[^|;&\n]*(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive[^|;&\n]*--force|--force[^|;&\n]*--recursive)/i;
      if (!rf.test(c)) return null;
      const dangerousTarget = HOME_OR_ROOT_TARGET.test(c) || /\s\/(?:\s|$)/.test(c) || /\brm\b[^|;&\n]*\*/.test(c);
      return { evidence: evidence(ctx.command!), severity: dangerousTarget ? "critical" : "high", mods: { dangerous_target: dangerousTarget } };
    },
  },
  {
    id: "destructive.git_reset_hard",
    category: "destructive",
    framework_ref: "OWASP ASI02",
    title: "Discards local changes (git reset --hard)",
    tools: ["Bash"],
    baseSeverity: "low", // routine dev op — only uncommitted working-tree changes are lost; commits survive in reflog
    test(ctx) {
      const c = ctx.commandBare;
      if (!c || !/\bgit\s+reset\s+--hard\b/i.test(c)) return null;
      return { evidence: evidence(ctx.command!) };
    },
  },
  {
    id: "destructive.git_force_push",
    category: "destructive",
    framework_ref: "OWASP ASI02",
    title: "Force-push rewrites remote history",
    tools: ["Bash"],
    baseSeverity: "low", // feature-branch force-push is routine; only a protected branch (below) is high
    test(ctx) {
      const c = ctx.commandBare;
      if (!c || !/\bgit\s+push\b[^|;&\n]*(--force\b|--force-with-lease\b|\s-f\b)/i.test(c)) return null;
      const mainBranch = /\b(main|master|release)\b/.test(c);
      return { evidence: evidence(ctx.command!), severity: mainBranch ? "high" : "low", mods: { protected_branch: mainBranch } };
    },
  },
  {
    id: "destructive.sql_drop",
    category: "destructive",
    framework_ref: "OWASP ASI02",
    title: "Drops or truncates a database object",
    tools: "*",
    baseSeverity: "high",
    test(ctx) {
      const query = typeof ctx.input?.query === "string" ? ctx.input.query : null;
      const hay = ctx.commandCode ?? query;
      if (!hay || !/\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE(\s+TABLE)?)\b/i.test(hay)) return null;
      return { evidence: evidence(ctx.command ?? query!) };
    },
  },
  {
    id: "destructive.disk_wipe",
    category: "destructive",
    framework_ref: "OWASP ASI02",
    title: "Low-level disk write / wipe (dd, mkfs, shred)",
    tools: ["Bash"],
    baseSeverity: "high",
    test(ctx) {
      const c = ctx.commandBare;
      if (!c || !/(\bdd\s+if=|\bmkfs(\.\w+)?\b|\bshred\b)/i.test(c)) return null;
      return { evidence: evidence(ctx.command!) };
    },
  },
  {
    id: "destructive.overwrite_critical",
    category: "destructive",
    framework_ref: "OWASP ASI02",
    title: "Overwrites a critical project file",
    tools: ["Write", "Edit", "MultiEdit"],
    baseSeverity: "low",
    test(ctx) {
      const f = ctx.filePath;
      if (!f) return null;
      const lock = /(^|\/)(package-lock\.json|pnpm-lock\.ya?ml|yarn\.lock|Cargo\.lock|go\.sum)\b/.test(f);
      // A CI-pipeline file is more sensitive than a lockfile: modifying it can run arbitrary code or
      // exfiltrate secrets in CI (a supply-chain risk), so it stays medium while lockfile churn is low.
      const ci = /(^|\/)(\.github\/workflows\/|\.gitlab-ci\.ya?ml)\b/.test(f);
      if (!lock && !ci) return null;
      return { evidence: evidence(f), severity: ci ? "medium" : "low", mods: { kind: ci ? "ci-config" : "lockfile" } };
    },
  },

  // --- Credential & secret access ------------------------------------------
  {
    id: "credential.secret_file_access",
    category: "credential-access",
    framework_ref: "MITRE ATLAS: Credential Access",
    title: "Reads a secret/credential file",
    tools: ["Read", "Bash"],
    baseSeverity: "high",
    test(ctx) {
      if (isBash(ctx.toolName)) {
        const cmd = ctx.commandBare; // executed view: a secret named only in a comment / echo / quoted arg isn't read
        if (!cmd) return null;
        // Evaluate each pipeline/command segment independently: a secret file is only *read* when a
        // content-read command (cat/grep/…) and the secret path occur in the SAME segment. A bare
        // `ls`/`file`/`stat` that merely names the path lists metadata; piping its OUTPUT into a
        // `grep`/`head` in a later segment (e.g. `file ~/.ssh/id_* | grep -v .pub`) exposes no secret
        // content — the read command never touches the file. Splitting first avoids matching the
        // read command against the wrong segment.
        const segments = cmd.split(/\|\||&&|[|;\n]/);
        const reads = segments.some(
          (seg) => SECRET_FILE.test(seg) && !EXAMPLE_FILE.test(seg) && CONTENT_READ_CMD.test(seg),
        );
        return reads ? { evidence: evidence(ctx.command!) } : null;
      }
      // Read tool: the filePath itself is the target (no command to segment).
      const f = ctx.filePath;
      if (!f || !SECRET_FILE.test(f) || EXAMPLE_FILE.test(f)) return null; // skip .env.example & templates
      return { evidence: evidence(f) };
    },
  },
  {
    id: "credential.secret_in_data",
    category: "credential-access",
    framework_ref: "MITRE ATLAS: Credential Access",
    title: "Secret-looking value in command or output",
    tools: "*",
    baseSeverity: "high",
    test(ctx) {
      const hay = [ctx.command, ctx.resultSummary].filter(Boolean).join("\n");
      if (!hay) return null;
      for (const p of SECRET_VALUE_PATTERNS) {
        const m = p.re.exec(hay);
        if (m) return { evidence: `${p.label}: ${evidence(m[0], 40)}`, severity: p.critical ? "critical" : "high", mods: { secret_kind: p.label } };
      }
      return null;
    },
  },

  // --- Data exfiltration (MITRE ATLAS AML.T0086) ---------------------------
  {
    id: "exfil.pipe_to_network",
    category: "exfiltration",
    framework_ref: "MITRE ATLAS AML.T0086",
    title: "Pipes local data into a network command",
    tools: ["Bash"],
    baseSeverity: "critical",
    test(ctx) {
      const c = ctx.commandBare;
      if (!c) return null;
      // e.g. `cat secrets | curl …`, `tar … | nc host port`, `… | curl -d @-`
      if (!/(\||<)\s*(sudo\s+)?(curl|wget|nc|ncat|netcat|ssh|scp)\b/i.test(c)) return null;
      if (!/\b(cat|tar|zip|gzip|base64|env|printenv|cat\s|<)\b/i.test(c)) return null;
      return { evidence: evidence(ctx.command!) };
    },
  },
  {
    id: "exfil.network_upload",
    category: "exfiltration",
    framework_ref: "MITRE ATLAS AML.T0086",
    title: "Uploads data to a network host",
    tools: ["Bash"],
    baseSeverity: "high",
    test(ctx) {
      const c = ctx.commandBare;
      if (!c) return null;
      // Upload-shaped curl/wget. NOTE: no /i flag — the short flags here are case-SENSITIVE (curl's -d
      // is data but -D is dump-header, -F is form but -f is --fail, -T is upload but -t is unrelated), so
      // matching case-insensitively turned plain GET smoke tests (`curl -sf`, `curl -D -`) into uploads.
      const upload = /\b(curl|wget)\b[^|;&\n]*(-X\s*POST|--data\b|--data-\w+\b|\s-d\b|-T\b|--upload-file\b|-F\b|--form\b)/.test(c);
      if (!upload) return null;
      // `@file` / --upload-file / -T means a real file is being sent (matched on commandBare so an `@`
      // inside a quoted arg — e.g. an email in a header value — doesn't count as a file).
      const withFile = /(@[^\s'"]+|--upload-file|\s-T\b)/.test(c);
      // Score by destination: external host = high (critical with a file); a private/internal host is a
      // lesser concern (low); a loopback call is local IPC / a dev server (info). Sending an actual file
      // bumps the internal/loopback tiers one step. An unrecognizable target (shell var) can't be shown
      // local, so it stays high. Classified on the verbatim command so quoted URLs are visible.
      const scope = netTargetScope(ctx.command!);
      let severity: Severity;
      if (scope === "external") severity = withFile ? "critical" : "high";
      else if (scope === "unknown") severity = "high";
      else severity = withFile ? bumpSeverity(scope === "loopback" ? "info" : "low", 1) : scope === "loopback" ? "info" : "low";
      return {
        evidence: evidence(ctx.command!),
        severity,
        mods: { target_scope: scope, with_file: withFile },
      };
    },
  },
  {
    id: "exfil.reverse_shell",
    category: "exfiltration",
    framework_ref: "MITRE ATLAS AML.T0086",
    title: "Netcat / reverse-shell style connection",
    tools: ["Bash"],
    baseSeverity: "critical",
    test(ctx) {
      const c = ctx.commandBare;
      if (!c) return null;
      if (!/\b(nc|ncat|netcat)\b[^|;&\n]*(-e\b|-c\b|\d{2,5})|\/dev\/tcp\/|bash\s+-i\b/i.test(c)) return null;
      return { evidence: evidence(ctx.command!) };
    },
  },

  // --- Privilege escalation / guardrail bypass (OWASP LLM06 Excessive Agency)
  {
    id: "privilege.skip_permissions",
    category: "privilege-bypass",
    framework_ref: "OWASP LLM06",
    title: "Bypasses the permission guardrail",
    tools: "*",
    baseSeverity: "high",
    test(ctx) {
      const c = ctx.commandBare;
      if (!c || !/--dangerously-skip-permissions\b|--yolo\b|--dangerously-skip\b/i.test(c)) return null;
      return { evidence: evidence(ctx.command!) };
    },
  },
  {
    id: "privilege.curl_pipe_shell",
    category: "privilege-bypass",
    framework_ref: "OWASP LLM06",
    title: "Executes a remote script (curl | sh)",
    tools: ["Bash"],
    baseSeverity: "high",
    test(ctx) {
      const c = ctx.commandBare;
      if (!c) return null;
      const m = /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(sh|bash|zsh|python\d?|node)\b([^|;&]*)/i.exec(c);
      if (!m) return null;
      // The danger is the interpreter executing the *downloaded body* piped to its stdin. A shell always
      // does. node/python execute piped stdin as a script only when NOT handed an inline program or
      // module — `curl … | node -e '…'`, `python -c '…'`, `python -m json.tool` just consume the output
      // as DATA (e.g. parsing an API response), which is not remote-script execution and must not flag.
      const interp = m[1].toLowerCase();
      const args = m[2] || "";
      if (/^(?:node|python)/.test(interp) && /(?:^|\s)-(?:e|c|m|p)\b|(?:^|\s)--(?:eval|command|module|print)\b/.test(args))
        return null;
      return { evidence: evidence(ctx.command!) };
    },
  },
  {
    id: "privilege.sudo",
    category: "privilege-bypass",
    framework_ref: "OWASP LLM06",
    title: "Runs a command as root (sudo)",
    tools: ["Bash"],
    baseSeverity: "high", // root escalation removes a real safety barrier — higher than an in-project op
    test(ctx) {
      const c = ctx.commandBare;
      // sudo must be in *command position* — start of the command or right after a separator (; | && ( ).
      // This ignores `sudo` as an argument (e.g. `apt install sudo`) and, via codeOf, inside echo/comments.
      if (!c || !/(?:^|[\n;|&(])\s*sudo\b/i.test(c)) return null;
      return { evidence: evidence(ctx.command!) };
    },
  },
  {
    id: "privilege.exec_generated_script",
    category: "privilege-bypass",
    framework_ref: "OWASP LLM06",
    title: "Writes a shell script from inline output and executes it",
    tools: ["Bash"],
    baseSeverity: "high",
    test(ctx) {
      const raw = ctx.command;
      if (!raw) return null;
      // Echoing a command into a file that is then run/sourced turns otherwise-inert printed text into
      // live code (e.g. `echo "sudo rm -rf /" > f.sh; sh f.sh`) — the reason we don't just ignore
      // dangerous tokens inside echo strings. Detect on the comment-stripped raw command.
      const file = execGeneratedScript(stripComments(raw));
      if (!file) return null;
      // Escalate when the generated script itself carries a destructive/privileged payload.
      const critical = /(?:^|["'\s;|&(])sudo\b|\brm\s+[^|;&\n]*-[a-z]*r[a-z]*f|\bchmod\s+0?777\b|\bmkfs|\bdd\s+if=/i.test(raw);
      return { evidence: evidence(raw), severity: critical ? "critical" : "high", mods: { script_file: file } };
    },
  },
  {
    id: "privilege.chmod_777",
    category: "privilege-bypass",
    framework_ref: "OWASP LLM06",
    title: "Overly permissive permissions (chmod 777)",
    tools: ["Bash"],
    baseSeverity: "medium",
    test(ctx) {
      const c = ctx.commandBare;
      if (!c || !/\bchmod\s+(-[a-zA-Z]+\s+)*0?777\b/i.test(c)) return null;
      return { evidence: evidence(ctx.command!) };
    },
  },
  {
    id: "privilege.persistence",
    category: "privilege-bypass",
    framework_ref: "OWASP LLM06",
    title: "Installs a persistence mechanism",
    tools: ["Bash"],
    baseSeverity: "high",
    test(ctx) {
      const c = ctx.commandBare;
      if (!c) return null;
      if (!/\bcrontab\s+-|\bsystemctl\s+enable\b|\blaunchctl\s+load\b|>>\s*~\/\.(bashrc|zshrc|profile|bash_profile)\b|\/etc\/(cron|systemd|rc\.local)/i.test(c)) return null;
      return { evidence: evidence(ctx.command!) };
    },
  },
  {
    id: "privilege.write_outside_project",
    category: "privilege-bypass",
    framework_ref: "OWASP LLM06",
    title: "Writes a file outside the working project",
    tools: ["Write", "Edit", "MultiEdit"],
    baseSeverity: "low", // writing to /tmp, scratch dirs, adjacent repos is routine; only a system path (below) is high
    test(ctx) {
      const f = ctx.filePath;
      if (!outsideProject(f, ctx.projectPath, ctx.ownedConfigDirs)) return null;
      const system = !!f && SYSTEM_PATH.test(f);
      return { evidence: evidence(f!), severity: system ? "high" : "low", mods: { project: ctx.projectPath, system_path: system } };
    },
  },
];

/** Rule → tool-name applicability. */
function appliesTo(rule: Rule, toolName: string): boolean {
  return rule.tools === "*" || rule.tools.includes(toolName);
}

/** Parse a tool call's verbatim input_json into a RuleContext (mirrors classify.ts's locDelta parse). */
function buildContext(
  row: { tool_name: string; input_json: string | null; result_summary: string | null; status: string | null },
  projectPath: string | null,
  ownedConfigDirs: string[],
): RuleContext {
  let input: any = null;
  try {
    input = row.input_json ? JSON.parse(row.input_json) : null;
  } catch {
    input = null;
  }
  const command = typeof input?.command === "string" ? input.command : null;
  const commandCode = command != null ? codeOf(command) : null;
  const commandBare = command != null ? bareOf(command) : null;
  const filePath = typeof input?.file_path === "string" ? input.file_path : null;
  return { toolName: row.tool_name, command, commandCode, commandBare, filePath, input, resultSummary: row.result_summary, status: row.status, projectPath, ownedConfigDirs };
}

interface ToolRow {
  id: string;
  session_id: string;
  event_uuid: string | null;
  turn_id: string | null;
  tool_name: string;
  input_json: string | null;
  result_summary: string | null;
  status: string | null;
}

/**
 * (Re)scan tool calls into the `findings` table. Returns the total finding count + engine version.
 * Deterministic; safe to run repeatedly. `dirty` (the expanded id set rebuildDerived returns) scopes an
 * incremental run to the touched sessions via delete-then-insert; null/undefined → scan everything.
 */
export function detect(db: DB, dirty?: Set<string> | null): { count: number; version: number } {
  const incremental = dirty != null;
  if (incremental) {
    db.exec("DROP TABLE IF EXISTS _dirty_sec");
    db.exec("CREATE TEMP TABLE _dirty_sec (id TEXT PRIMARY KEY)");
    const ins = db.prepare("INSERT OR IGNORE INTO _dirty_sec (id) VALUES (?)");
    db.transaction((ids: Iterable<string>) => {
      for (const id of ids) ins.run(id);
    })(dirty);
  }
  const scope = incremental ? " WHERE tc.session_id IN (SELECT id FROM _dirty_sec)" : "";

  // Agent-owned config roots — the configured sources' `config_dir`s (seeded from the project config
  // file at ingest). Single source of truth for the write_outside_project allowlist, so relocated or
  // side-by-side installs (~/.claude, ~/.claude-isf, …) are covered without a hardcoded path pattern.
  const ownedConfigDirs = (db.prepare("SELECT config_dir FROM sources WHERE config_dir IS NOT NULL").all() as Array<{ config_dir: string }>)
    .map((r) => r.config_dir.replace(/\/$/, ""))
    .filter(Boolean);

  // Project path per (scoped) session — for outside-project checks.
  const projPath = new Map<string, string>();
  for (const r of db
    .prepare(
      `SELECT s.id id, p.path path FROM sessions s JOIN projects p ON p.id = s.project_id${
        incremental ? " WHERE s.id IN (SELECT id FROM _dirty_sec)" : ""
      }`,
    )
    .all() as Array<{ id: string; path: string }>) {
    projPath.set(r.id, r.path);
  }

  const rows = db
    .prepare(
      `SELECT tc.id, tc.session_id, tc.event_uuid, tc.turn_id, tc.tool_name, tc.input_json, tc.result_summary, tc.status
       FROM tool_calls tc${scope}`,
    )
    .all() as ToolRow[];

  const insert = db.prepare(
    `INSERT INTO findings (id, session_id, tool_call_id, event_uuid, turn_id, rule_id, category, framework_ref, severity, title, evidence, signals_json, detector_version)
     VALUES (@id, @session_id, @tool_call_id, @event_uuid, @turn_id, @rule_id, @category, @framework_ref, @severity, @title, @evidence, @signals_json, @detector_version)
     ON CONFLICT(id) DO NOTHING`,
  );
  const delScope = incremental
    ? "DELETE FROM findings WHERE session_id IN (SELECT id FROM _dirty_sec)"
    : "DELETE FROM findings";

  const tx = db.transaction(() => {
    db.exec(delScope);
    for (const row of rows) {
      const ctx = buildContext(row, projPath.get(row.session_id) ?? null, ownedConfigDirs);
      for (const rule of RULES) {
        if (!appliesTo(rule, ctx.toolName)) continue;
        const m = rule.test(ctx);
        if (!m) continue;
        let severity: Severity = m.severity ?? rule.baseSeverity;
        const mods: Record<string, unknown> = { ...(m.mods ?? {}) };
        // A failed/blocked tool call is an *attempt*, not an accomplished action — de-escalate one band.
        if (row.status === "error") {
          severity = bumpSeverity(severity, -1);
          mods.attempted = true;
        }
        const signals = {
          rule: rule.id,
          category: rule.category,
          framework_ref: rule.framework_ref,
          tool_name: ctx.toolName,
          base_severity: rule.baseSeverity,
          severity,
          status: row.status,
          modifiers: mods,
          detector_version: DETECTOR_VERSION,
        };
        insert.run({
          id: findingId(row.id, rule.id),
          session_id: row.session_id,
          tool_call_id: row.id,
          event_uuid: row.event_uuid,
          turn_id: row.turn_id,
          rule_id: rule.id,
          category: rule.category,
          framework_ref: rule.framework_ref,
          severity,
          title: rule.title,
          evidence: m.evidence,
          signals_json: JSON.stringify(signals),
          detector_version: DETECTOR_VERSION,
        });
      }
    }
  });
  tx();

  if (incremental) db.exec("DROP TABLE IF EXISTS _dirty_sec");
  const count = (db.prepare("SELECT COUNT(*) n FROM findings").get() as { n: number }).n;
  return { count, version: DETECTOR_VERSION };
}
