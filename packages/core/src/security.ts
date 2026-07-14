/**
 * Agent Lens — security findings: shared severity model + framework-anchored reference content
 * (ADR-017). This is the low-level, dependency-free source of truth so the ingest detector
 * (packages/ingest/src/detect.ts), the server queries, and the web UI all agree on the severity
 * ordering and the category taxonomy. The reference content also powers the "what & why" explainer
 * blocks on the /security page.
 */

export type Severity = "info" | "low" | "medium" | "high" | "critical";

/** Ascending order of concern; index doubles as the numeric rank (info=0 … critical=4). */
export const SEVERITY_ORDER: Severity[] = ["info", "low", "medium", "high", "critical"];

/** Numeric rank of a severity (info=0 … critical=4); -1 for an unknown value. */
export function severityRank(s: string): number {
  return SEVERITY_ORDER.indexOf(s as Severity);
}

/** Shift a severity by `delta` bands, clamped to the [info, critical] range. */
export function bumpSeverity(s: Severity, delta: number): Severity {
  const i = SEVERITY_ORDER.indexOf(s);
  const j = Math.max(0, Math.min(SEVERITY_ORDER.length - 1, i + delta));
  return SEVERITY_ORDER[j];
}

/** The four v1 risk families a finding is categorized into. */
export type SecurityCategoryKey = "destructive" | "credential-access" | "exfiltration" | "privilege-bypass";

export interface SecurityCategoryRef {
  key: SecurityCategoryKey;
  title: string;
  /** Short framework anchor shown as a chip (matches findings.framework_ref). */
  framework_ref: string;
  framework_url: string;
  /** What the detector looks for. */
  what: string;
  /** Why it matters for a host running an autonomous agent. */
  why: string;
  /** What to do when you see one. */
  remediation: string;
}

/**
 * Reference content for each category — the browsable "security page with info" the feature was scoped
 * around. Anchored to OWASP Top 10 for Agentic Apps 2026 and MITRE ATLAS. Kept deliberately concise;
 * the point is orientation, not a full framework reproduction.
 */
export const SECURITY_CATEGORIES: SecurityCategoryRef[] = [
  {
    key: "destructive",
    title: "Destructive & data-loss operations",
    framework_ref: "OWASP ASI02",
    framework_url: "https://genai.owasp.org/",
    what: "Commands or edits that irreversibly delete, overwrite, or truncate data — rm -rf, git reset --hard, force-pushes, DROP/TRUNCATE, disk writes (dd/mkfs/shred), and overwrites of critical project files (lockfiles, CI config).",
    why: "An agent acting on a bad plan or a poisoned instruction can wipe work, history, or a database with a single tool call. Because agent-lens sees sessions after the fact, this is how you notice the damage — and the blast radius — even when nobody was watching live.",
    remediation: "Open the flagged session, confirm the target was intended, and check the tool result for whether it succeeded. Restore from git/backups if needed, and consider a PreToolUse hook to block the pattern going forward.",
  },
  {
    key: "credential-access",
    title: "Secret & credential access",
    framework_ref: "MITRE ATLAS: Credential Access",
    framework_url: "https://atlas.mitre.org/",
    what: "Reads of secret-bearing files (.env, ~/.ssh keys, ~/.aws/credentials, .npmrc, .pem) or secret-looking values (private keys, AWS keys, GitHub/Slack tokens) appearing in a command or a captured tool result.",
    why: "Credentials the agent touched may have been exposed to the model context, logs, or a downstream tool — and could be leaked or reused. Retrospective visibility tells you which secrets to rotate.",
    remediation: "Treat any accessed secret as potentially exposed: rotate it. Verify the access was purposeful, and keep secrets out of the working tree the agent operates on.",
  },
  {
    key: "exfiltration",
    title: "Data exfiltration",
    framework_ref: "MITRE ATLAS AML.T0086",
    framework_url: "https://atlas.mitre.org/techniques/AML.T0086",
    what: "Local data flowing outbound: curl/wget uploads to external hosts, piping files into a network command, netcat/reverse-shell patterns, and other ways an agent's write-capable tools become an exfiltration channel.",
    why: "Exfiltration via the agent's own tool calls (AML.T0086) is a primary agentic attack path — a prompt-injected agent can POST your files or secrets to an attacker with one command. These are the highest-signal findings to review.",
    remediation: "Inspect the destination host and the data referenced in the command. If it was not you, treat it as an incident: rotate anything referenced, review what left the host, and audit the session for the injection source.",
  },
  {
    key: "privilege-bypass",
    title: "Privilege escalation & guardrail bypass",
    framework_ref: "OWASP LLM06",
    framework_url: "https://genai.owasp.org/",
    what: "Actions that widen the agent's authority or sidestep safety: sudo, chmod 777, curl | sh, --dangerously-skip-permissions, writes outside the working project, and persistence mechanisms (cron, systemd, shell rc files).",
    why: "Excessive agency (LLM06) is the root cause behind most agent incidents — every disabled guardrail or out-of-scope write removes a barrier the design relied on. Persistence in particular outlives the session that created it.",
    remediation: "Confirm the escalation was necessary and scoped. Remove any persistence the agent added, re-tighten permissions, and avoid running agents with skipped permission prompts on a trusted host.",
  },
];

/** Quick lookup of a category's reference content by key. */
export function securityCategory(key: string): SecurityCategoryRef | undefined {
  return SECURITY_CATEGORIES.find((c) => c.key === key);
}
