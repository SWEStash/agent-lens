/**
 * Redacted export sanitizer (backlog #3). Unlike the corpus Redactor (deny-by-default, for a
 * metric-preserving test corpus), this is a SELECTIVE share sanitizer: it keeps the narrative
 * readable and masks only secrets/PII, with a fail-closed post-render scan. A `structure` level
 * offers the aggressive scrub, and `off` is the explicit verbatim opt-out.
 *
 * Imports the BUILT dist so it exercises exactly what ships.
 */
import { describe, it, expect } from "vitest";
import type { MarkdownSession, MarkdownEvent } from "@agent-lens/core";
import { exportMarkdown, maskSecrets } from "../dist/redact-export.js";
import { findLeak, findShareLeak } from "../dist/secrets.js";

const GHP = "ghp_" + "a".repeat(36);
const SK = "sk-" + "b".repeat(24);
const XOXB = "xoxb-123456789012-abcdefghij";
const AKIA = "AKIAIOSFODNN7EXAMPLE"; // AKIA + 16 chars, the canonical AWS example key
const PEM = "-----BEGIN RSA PRIVATE KEY-----";

function fixture(): { session: MarkdownSession; events: MarkdownEvent[] } {
  const session: MarkdownSession = {
    id: "sess-abcdef1234",
    title: "Deploy to prod",
    source: "personal",
    project: "/home/alice/projects/secret-app",
    model: "claude-opus-4-8",
    started_at: "2026-07-18T00:00:00Z",
    ended_at: "2026-07-18T00:05:00Z",
  };
  const events: MarkdownEvent[] = [
    {
      type: "message",
      role: "assistant",
      timestamp: "2026-07-18T00:01:00Z",
      text: `Deploying with key ${AKIA} and ${GHP} and ${XOXB}. Ping alice@acme.com at 10.0.0.5. See https://docs.acme.com/guide.`,
      thinking: `home is /home/alice ; use ${SK}\n${PEM}`,
      toolCalls: [
        {
          tool_name: "Bash",
          skill_name: null,
          agent_type: null,
          status: "success",
          input_json: JSON.stringify({ command: `aws deploy --key ${AKIA}` }),
        },
      ],
    },
  ];
  return { session, events };
}

describe("exportMarkdown — secrets level (default, selective)", () => {
  it("masks each secret value with its label and drops the raw secret", () => {
    const { session, events } = fixture();
    const { markdown } = exportMarkdown(session, events, { level: "secrets" });
    expect(markdown).toContain("[AWS-KEY]");
    expect(markdown).toContain("[GITHUB-TOKEN]");
    expect(markdown).toContain("[SLACK-TOKEN]");
    expect(markdown).toContain("[API-KEY]");
    expect(markdown).toContain("[PRIVATE-KEY]");
    expect(markdown).not.toContain(AKIA);
    expect(markdown).not.toContain(GHP);
    expect(markdown).not.toContain(XOXB);
    expect(markdown).not.toContain(SK);
    expect(markdown).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  it("masks email + IPv4 and strips the home username but keeps the rest of the path", () => {
    const { session, events } = fixture();
    const { markdown } = exportMarkdown(session, events, { level: "secrets" });
    expect(markdown).toContain("[EMAIL]");
    expect(markdown).not.toContain("alice@acme.com");
    expect(markdown).toContain("[IP]");
    expect(markdown).not.toContain("10.0.0.5");
    expect(markdown).toContain("/home/user/projects/secret-app");
    expect(markdown).not.toContain("/home/alice");
  });

  it("preserves the narrative, keeps ordinary URLs, is fail-closed clean, and carries the disclaimer", () => {
    const { session, events } = fixture();
    const { markdown, residualLeak, level } = exportMarkdown(session, events, { level: "secrets" });
    expect(markdown).toContain("Deploying with key");
    expect(markdown).toContain("https://docs.acme.com/guide"); // ordinary links stay readable
    expect(markdown).toContain("Redacted export");
    expect(markdown).toContain("never uploaded");
    expect(findShareLeak(markdown)).toBeNull();
    expect(residualLeak).toBe(false);
    expect(level).toBe("secrets");
  });

  it("defaults to the secrets level when none is given", () => {
    const { session, events } = fixture();
    const def = exportMarkdown(session, events, {});
    expect(def.level).toBe("secrets");
    expect(def.markdown).not.toContain(AKIA);
  });
});

describe("exportMarkdown — structure level (aggressive scrub)", () => {
  it("replaces narrative with [redacted], empties tool inputs, and is leak-free", () => {
    const { session, events } = fixture();
    const { markdown } = exportMarkdown(session, events, { level: "structure" });
    expect(markdown).toContain("[redacted]");
    expect(markdown).not.toContain("Deploying with key");
    expect(markdown).not.toContain("aws deploy");
    expect(markdown).not.toContain(AKIA);
    expect(findLeak(markdown)).toBeNull();
  });
});

describe("exportMarkdown — off (verbatim opt-out)", () => {
  it("preserves the raw secret and omits the disclaimer", () => {
    const { session, events } = fixture();
    const { markdown, level } = exportMarkdown(session, events, { level: "off" });
    expect(markdown).toContain(AKIA);
    expect(markdown).not.toContain("Redacted export");
    expect(level).toBe("off");
  });
});

describe("exportMarkdown — encoded project-dir paths (regression)", () => {
  // Claude Code encodes a project path by replacing "/" with "-", so /home/m4pre/git-projects/x
  // becomes -home-m4pre-git-projects-x. This leaked the username through scratchpad/task paths that
  // appear verbatim in transcript text — the slash-form home-strip walked right past it.
  const ENCODED = "/tmp/claude-1000/-home-m4pre-git-projects-swestash-agent-lens/ce037d95/tasks/a96a.output";

  it("secrets level strips the username from an ENCODED home path in narrative text", () => {
    const session: MarkdownSession = { ...fixture().session, project: "/tmp/x" };
    const events: MarkdownEvent[] = [
      { type: "message", role: "assistant", timestamp: "t", text: `wrote output to ${ENCODED}`, thinking: null, toolCalls: [] },
    ];
    const { markdown, residualLeak } = exportMarkdown(session, events, { level: "secrets" });
    expect(markdown).not.toContain("m4pre");
    expect(markdown).toContain("-home-user-git-projects-swestash-agent-lens"); // structure kept, user stripped
    expect(findShareLeak(markdown)).toBeNull();
    expect(residualLeak).toBe(false);
  });

  it("findShareLeak flags an un-masked encoded home path", () => {
    expect(findShareLeak("ran in -home-m4pre-git-projects-swestash-agent-lens/x")).not.toBeNull();
    expect(findShareLeak("ran in -home-user-git-projects-swestash-agent-lens/x")).toBeNull();
  });
});

describe("maskSecrets — URL-embedded credentials (kept-readable URLs must not leak creds)", () => {
  it("masks basic-auth userinfo but keeps the host", () => {
    const out = maskSecrets("clone https://alice:s3cr3tPW@git.example.com/repo.git");
    expect(out).not.toContain("s3cr3tPW");
    expect(out).not.toContain("alice:");
    expect(out).toContain("git.example.com/repo.git");
    expect(out).toContain("[REDACTED-AUTH]");
  });

  it("masks a DB connection string's credentials", () => {
    const out = maskSecrets("postgres://dbuser:dbpass123@localhost:5432/app");
    expect(out).not.toContain("dbpass123");
    expect(out).toContain("localhost:5432/app");
  });

  it("masks credential-bearing query params but keeps benign ones and the host", () => {
    const out = maskSecrets("GET https://api.example.com/x?api_key=ABCD1234EFGH5678&page=2");
    expect(out).not.toContain("ABCD1234EFGH5678");
    expect(out).toContain("page=2");
    expect(out).toContain("api.example.com");
  });

  it("findShareLeak flags raw basic-auth URL creds", () => {
    expect(findShareLeak("https://u:p@h.com")).not.toBeNull();
    expect(findShareLeak("https://[REDACTED-AUTH]@h.com")).toBeNull();
  });
});

describe("maskSecrets — additional secret token formats", () => {
  const cases: Array<[string, string, string]> = [
    ["Google API key", "AIza" + "b".repeat(35), "[GOOGLE-API-KEY]"],
    ["Stripe live key", "sk_live_" + "a".repeat(24), "[STRIPE-KEY]"],
    ["OpenAI project key", "sk-proj-" + "A".repeat(40), "[API-KEY]"],
    ["Anthropic key", "sk-ant-api03-" + "B".repeat(30), "[API-KEY]"],
    ["GitHub fine-grained PAT", "github_pat_" + "C".repeat(30), "[GITHUB-TOKEN]"],
    ["npm token", "npm_" + "d".repeat(36), "[NPM-TOKEN]"],
    ["JWT", "eyJ" + "a".repeat(12) + "." + "b".repeat(12) + "." + "c".repeat(8), "[JWT]"],
  ];
  for (const [name, raw, label] of cases) {
    it(`masks ${name}`, () => {
      const out = maskSecrets(`token is ${raw} ok`);
      expect(out).not.toContain(raw);
      expect(out).toContain(label);
    });
  }
});

describe("exportMarkdown — derive & scrub the session's username", () => {
  it("scrubs the home-dir owner everywhere it appears (URLs, prose), not just in /home paths", () => {
    const session: MarkdownSession = { ...fixture().session, title: null, project: "/home/m4pre/git-projects/x" };
    const events: MarkdownEvent[] = [
      { type: "message", role: "assistant", timestamp: "t", thinking: null, toolCalls: [],
        text: "pushed to github.com/m4pre/site and pinged m4pre about it" },
    ];
    const { markdown } = exportMarkdown(session, events, { level: "secrets" });
    expect(markdown).not.toContain("m4pre");
    expect(markdown).toContain("[USER]");
    expect(markdown).toContain("github.com/[USER]/site");
    expect(markdown).toContain("/home/user/git-projects/x"); // home path still stripped structurally
  });

  it("does NOT scrub a common/non-identifying owner like 'ubuntu' (avoids mangling the OS name)", () => {
    const session: MarkdownSession = { ...fixture().session, title: null, project: "/home/ubuntu/app" };
    const events: MarkdownEvent[] = [
      { type: "message", role: "assistant", timestamp: "t", thinking: null, toolCalls: [], text: "deploy on Ubuntu 24.04" },
    ];
    const { markdown } = exportMarkdown(session, events, { level: "secrets" });
    expect(markdown).toContain("Ubuntu 24.04"); // not turned into [USER] 24.04
    expect(markdown).toContain("/home/user/app"); // home strip still applies
  });
});

describe("maskSecrets — env-var secret assignments (conservative)", () => {
  it("masks a literal password/secret/token value", () => {
    expect(maskSecrets("DB_PASSWORD=hunter2")).toBe("DB_PASSWORD=[REDACTED]");
    expect(maskSecrets("run with PASSWORD=abc123xyz now")).toContain("PASSWORD=[REDACTED]");
    expect(maskSecrets("API_TOKEN=opaqueLiteralValue123")).toContain("API_TOKEN=[REDACTED]");
  });

  it("keeps variable references (not a leak)", () => {
    expect(maskSecrets("JWT_SECRET=${CI_JWT}")).toContain("${CI_JWT}");
    expect(maskSecrets("DB_PASSWORD=$PGPASS")).toContain("$PGPASS");
  });

  it("does not touch non-sensitive assignments", () => {
    expect(maskSecrets("PORT=8080 LOG_LEVEL=debug")).toBe("PORT=8080 LOG_LEVEL=debug");
  });
});

describe("maskSecrets + relocated leak scan", () => {
  it("maskSecrets is idempotent and labels a bare token", () => {
    const once = maskSecrets(`token ${GHP}`);
    expect(once).toContain("[GITHUB-TOKEN]");
    expect(maskSecrets(once)).toBe(once);
  });

  it("core re-exports a working findLeak", () => {
    expect(findLeak("reach me at alice@acme.com")).not.toBeNull();
    expect(findLeak("nothing to see here")).toBeNull();
  });
});
