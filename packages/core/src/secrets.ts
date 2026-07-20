/**
 * Canonical secret / PII patterns — single source of truth for masking and leak-scanning.
 *
 * Two consumers:
 *   • the corpus redactor's fail-closed scan (`LEAK_PATTERNS` / `findLeak`, relocated here from
 *     packages/ingest/src/redact.ts and re-exported there so its API is unchanged), and
 *   • the redacted-export sanitizer (`maskSecrets`, `findShareLeak`) — see redact-export.ts.
 *
 * NOTE: packages/ingest/src/detect.ts keeps its own SECRET_VALUE_PATTERNS today (its v8 rules are
 * FP-tuned around them); a future cleanup can have it import SECRET_PATTERNS from here to dedupe.
 */

export interface LeakPattern {
  name: string;
  re: RegExp;
}

/** Patterns that must NEVER appear in redacted CORPUS output (strict, forbids URLs/IPs entirely). */
export const LEAK_PATTERNS: LeakPattern[] = [
  { name: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "home-path-with-user", re: /\/(?:home|Users)\/(?!user\b)[A-Za-z0-9._-]+/ },
  { name: "ipv4", re: /\b\d{1,3}(?:\.\d{1,3}){3}\b/ },
  { name: "url", re: /https?:\/\/[^\s"']+/ },
  { name: "aws-key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "bearer/token", re: /\b(?:sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9]{8,}/ },
];

/** Return the first leak found by `patterns` (default: strict corpus set), or null. */
export function findLeak(text: string, patterns: LeakPattern[] = LEAK_PATTERNS): { name: string; sample: string } | null {
  for (const { name, re } of patterns) {
    const m = re.exec(text);
    if (m) return { name, sample: m[0].slice(0, 40) };
  }
  return null;
}

/** Secret VALUE patterns → a human-readable placeholder label. Mirrors detect.ts's stronger set,
 * extended (2026-07-18 audit) with formats seen in the wild: Google/Stripe/OpenAI/Anthropic keys,
 * GitHub fine-grained PATs, npm tokens, Slack app tokens, and JWTs. Hyphen/underscore-bearing keys
 * (sk-proj-…, sk-ant-…, sk_live_…) need their own entries — the generic `sk-…{20,}` stops at the
 * first separator and would miss them. */
export const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g, label: "PRIVATE-KEY" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: "AWS-KEY" },
  { re: /\bASIA[0-9A-Z]{16}\b/g, label: "AWS-KEY" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, label: "GITHUB-TOKEN" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, label: "GITHUB-TOKEN" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: "SLACK-TOKEN" },
  { re: /\bxapp-[0-9A-Za-z-]{10,}/g, label: "SLACK-TOKEN" },
  { re: /\bnpm_[A-Za-z0-9]{30,}/g, label: "NPM-TOKEN" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: "GOOGLE-API-KEY" },
  { re: /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g, label: "STRIPE-KEY" },
  { re: /\bsk-(?:proj|ant|or|svcacct)-[A-Za-z0-9_-]{20,}/g, label: "API-KEY" },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/g, label: "API-KEY" },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, label: "JWT" },
];

/** URL-embedded credentials survive the kept-readable-URLs policy, so mask them explicitly:
 * basic-auth userinfo (`scheme://user:pass@host` → keep the host) and secret query-param values. */
function maskUrlCredentials(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@"'`]+:[^/\s@"'`]+@/gi, "$1[REDACTED-AUTH]@")
    .replace(
      /([?&](?:access_?token|api[_-]?key|apikey|token|secret|password|pwd|client[_-]?secret|auth|signature|sig)=)[^&\s"'`<>]+/gi,
      "$1[REDACTED]",
    );
}

/** Conservative env-var secret assignment: mask a LITERAL value of NAME=… when NAME looks secret
 * (…_TOKEN/_SECRET/_KEY/_PASSWORD/… or a bare PASSWORD/SECRET/TOKEN) and the value is not a `$VAR`
 * / `${VAR}` reference (those are safe and common, so kept). Known key formats are already handled
 * by SECRET_PATTERNS; this catches opaque literals like `DB_PASSWORD=hunter2`. */
const ENV_ASSIGN =
  /\b([A-Za-z][A-Za-z0-9_]*_(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD|PWD|PW|CREDENTIALS?)|PASSWORD|PASSWD|SECRET|TOKEN)=(["']?)(?!\$)[^\s"'`&;|<>()]+/gi;
function maskEnvAssignments(text: string): string {
  return text.replace(ENV_ASSIGN, (_m, name, q) => `${name}=${q}[REDACTED]`);
}

/** PII value patterns → placeholder label (home paths are handled separately, username-strip only). */
export const PII_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, label: "EMAIL" },
  { re: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g, label: "IP" },
];

/** Strip only the `<user>` segment of a home path so `/home/alice/x` → `/home/user/x` (rest kept). */
const HOME_USER = /\/(home|Users)\/[^/\s"'`]+/g;

/** Claude Code encodes a project path by replacing "/" with "-", so `/home/alice/proj` becomes
 * `-home-alice-proj`. That form appears verbatim in scratchpad/task paths in transcript text and
 * leaks the username past the slash-form strip. Match `-home-<user>-` (not preceded by an
 * alphanumeric, so `flex-home-x` is left alone) and drop only the username segment. */
const ENCODED_HOME_USER = /(?<![A-Za-z0-9])(-(?:home|Users)-)[A-Za-z0-9._]+(?=-)/g;

/** Windows profile path: `C:\Users\Alice\…` → `C:\Users\user\…`. */
const WINDOWS_USER = /([A-Za-z]:\\Users\\)[^\\/\s"'`]+/gi;

/**
 * Selective share masking: replace secret values and PII with labels, and strip home usernames,
 * while leaving the surrounding narrative (and ordinary URLs) readable. Idempotent.
 */
export function maskSecrets(text: string): string {
  let out = maskUrlCredentials(text);
  out = maskEnvAssignments(out);
  for (const { re, label } of SECRET_PATTERNS) out = out.replace(re, `[${label}]`);
  for (const { re, label } of PII_PATTERNS) out = out.replace(re, `[${label}]`);
  out = out.replace(HOME_USER, (_m, root) => `/${root}/user`);
  out = out.replace(ENCODED_HOME_USER, (_m, root) => `${root}user`);
  out = out.replace(WINDOWS_USER, (_m, root) => `${root}user`);
  return out;
}

/**
 * Fail-closed scan set for the selective `secrets` share level: secret values + email +
 * home-path-with-user. Deliberately EXCLUDES generic url/ipv4 so legitimate doc links stay
 * readable (IPs are already masked by maskSecrets).
 */
export const SHARE_LEAK: LeakPattern[] = [
  ...SECRET_PATTERNS.map(({ re, label }) => ({ name: label, re: new RegExp(re.source) })),
  { name: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "home-path-with-user", re: /\/(?:home|Users)\/(?!user\b)[A-Za-z0-9._-]+/ },
  { name: "encoded-home-with-user", re: /(?<![A-Za-z0-9])-(?:home|Users)-(?!user-)[A-Za-z0-9._]+-/ },
  { name: "url-credentials", re: /:\/\/[^/\s:@"'`]+:[^/\s@"'`]+@/ },
];

/** First leak under the selective share set, or null. */
export function findShareLeak(text: string): { name: string; sample: string } | null {
  return findLeak(text, SHARE_LEAK);
}

// Common / non-identifying home-dir owners — masking these would mangle prose (e.g. the OS name
// "Ubuntu") without protecting an individual's identity, so they are never scrubbed as a username.
const USER_STOPLIST = new Set([
  "user", "users", "home", "root", "admin", "ubuntu", "runner", "node", "app", "apps",
  "data", "tmp", "shared", "public", "guest", "vagrant", "ec2-user", "docker",
]);
// A home-dir owner: the segment right after a home root, in slash, encoded, or Windows form.
// The username capture excludes "-" so the encoded form (-home-u-proj) stops at the next segment.
const HOME_OWNER = /(?:\/(?:home|Users)\/|-(?:home|Users)-|[A-Za-z]:\\Users\\)([A-Za-z0-9._]{3,})/g;

/** Derive the username(s) that own a home directory anywhere in the given texts. These are provably
 * PII (they own a home dir in the transcript), so they can be scrubbed everywhere — including bare
 * occurrences in URLs/prose that no path pattern would catch. Common/OS owners are excluded. */
export function deriveHomeUsers(texts: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    const re = new RegExp(HOME_OWNER.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      const u = m[1]!;
      if (u.length >= 3 && !USER_STOPLIST.has(u.toLowerCase())) found.add(u);
    }
  }
  return [...found];
}

/** Replace whole-token occurrences of each derived username with `[USER]`. */
export function scrubUsernames(text: string, users: string[]): string {
  let out = text;
  for (const u of users) {
    const esc = u.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, "g"), "[USER]");
  }
  return out;
}
