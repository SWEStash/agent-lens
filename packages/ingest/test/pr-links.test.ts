/**
 * The PRs and pushed branches a session touched (ADR-041, #78): the Claude Code adapter reads
 * `pr-link` records and the `gitOperation` on Bash results, and ingest keeps one row per PR and per
 * branch for the session. A session that recorded none has no rows.
 */
import { describe, it, expect } from "vitest";
import type { SourceFile } from "@agent-lens/core";
import { openDb } from "../dist/db.js";
import { prepareStatements, ingestFile, rebuildDerived, newStats } from "../dist/pipeline.js";
import { ClaudeCodeAdapter, parsePrUrl } from "../dist/adapters/claude-code.js";
import { jsonl } from "./helpers/seed.js";

const SOURCE = "test";
const AGENT = "claude-code";
const T = (n: number) => `2026-04-01T00:${String(n).padStart(2, "0")}:00.000Z`;
const GH = "https://github.com/demo/acme-api/pull/42";
const GL = "https://gitlab.example.com/group/sub/widget/-/merge_requests/7";

/** A Bash call and its result, the result carrying `op` as toolUseResult.gitOperation. */
function bash(n: number, id: string, op: unknown): object[] {
  return [
    {
      uuid: `use-${id}`,
      type: "assistant",
      timestamp: T(2 * n),
      message: { role: "assistant", model: "claude-opus-5", content: [{ type: "tool_use", id, name: "Bash", input: { command: "git" } }] },
    },
    {
      uuid: `res-${id}`,
      type: "user",
      timestamp: T(2 * n + 1),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
      toolUseResult: { stdout: "ok", stderr: "", interrupted: false, isImage: false, gitOperation: op },
    },
  ];
}
const prLink = (n: number, prNumber: unknown, prUrl: unknown, prRepository: unknown) => ({
  type: "pr-link",
  sessionId: "s",
  timestamp: T(n),
  prNumber,
  prUrl,
  prRepository,
});
const prompt = { uuid: "prompt", type: "user", timestamp: T(0), cwd: "/tmp/proj", message: { role: "user", content: "go" } };

function setup() {
  const db = openDb(":memory:");
  const stmts = prepareStatements(db);
  stmts.insAgent.run(AGENT, "Claude Code CLI");
  stmts.insSource.run({ id: SOURCE, label: SOURCE, agent_id: AGENT, config_dir: null });
  const ingest = (sessionId: string, lines: string, isVersion = false, path = `/fixtures/${sessionId}.jsonl`) => {
    const file: SourceFile = { path, sessionId, encodedDir: "-fixtures", isVersion, sourceId: SOURCE };
    ingestFile(db, stmts, new ClaudeCodeAdapter(), file, lines.split("\n"), { size: lines.length, mtimeMs: 0, hash: path }, T(0), newStats());
    rebuildDerived(db);
  };
  const prs = (s: string) =>
    db.prepare("SELECT repository, number, url, first_seen_at, opened_here FROM session_prs WHERE session_id = ? ORDER BY repository, number").all(s);
  const branches = (s: string) =>
    db.prepare("SELECT branch, first_pushed_at FROM session_branches WHERE session_id = ? ORDER BY branch").all(s);
  return { db, ingest, prs, branches };
}

describe("parsePrUrl", () => {
  it("reads GitHub and GitLab URLs on any host", () => {
    expect(parsePrUrl(GH)).toEqual({ url: GH, repository: "demo/acme-api", number: 42 });
    expect(parsePrUrl(GL)).toEqual({ url: GL, repository: "group/sub/widget", number: 7 });
    expect(parsePrUrl("https://ghe.corp.example/o/r/pull/3/")).toMatchObject({ repository: "o/r", number: 3 });
  });
  it("rejects anything that is not an http(s) PR URL, since it is rendered as a link", () => {
    for (const bad of ["javascript:alert(1)//o/r/pull/1", "file:///o/r/pull/1", "https://github.com/o/r/issues/4", "not a url", 42, null]) {
      expect(parsePrUrl(bad)).toBeNull();
    }
  });
});

describe("session PR and branch links", () => {
  it("stores pr-link records once per PR, keeping the earliest sighting", () => {
    const { ingest, prs } = setup();
    ingest("s1", jsonl(prompt, prLink(1, 42, GH, "demo/acme-api"), prLink(5, 42, GH, "demo/acme-api"), prLink(6, 7, GL, "group/sub/widget")));
    expect(prs("s1")).toEqual([
      { repository: "demo/acme-api", number: 42, url: GH, first_seen_at: T(1), opened_here: 0 },
      { repository: "group/sub/widget", number: 7, url: GL, first_seen_at: T(6), opened_here: 0 },
    ]);
  });

  it("reads gitOperation pushes and PR actions, resolving a URL-less close by number", () => {
    const { ingest, prs, branches } = setup();
    ingest(
      "s2",
      jsonl(
        prompt,
        ...bash(1, "push", { push: { branch: "feat/x" } }),
        ...bash(2, "create", { pr: { number: 42, url: GH, action: "created" } }),
        ...bash(3, "push2", { push: { branch: "feat/x" } }),
        ...bash(4, "close", { pr: { number: 42, action: "closed" } }),
      ),
    );
    expect(prs("s2")).toEqual([{ repository: "demo/acme-api", number: 42, url: GH, first_seen_at: T(5), opened_here: 1 }]);
    expect(branches("s2")).toEqual([{ branch: "feat/x", first_pushed_at: T(3) }]);
  });

  it("drops a number-only PR it cannot place in a repository", () => {
    const { ingest, prs } = setup();
    ingest("s3", jsonl(prompt, ...bash(1, "merge", { pr: { number: 9, action: "merged" } })));
    expect(prs("s3")).toEqual([]);
  });

  it("adds a .versions copy's refs without losing the mirror's, whatever the order", () => {
    const { ingest, prs } = setup();
    ingest("s4", jsonl(prompt, ...bash(1, "create", { pr: { number: 42, url: GH, action: "created" } })));
    ingest("s4", jsonl(prompt, prLink(0, 42, null, "demo/acme-api")), true, "/fixtures/.versions/1/s4.jsonl");
    expect(prs("s4")).toEqual([{ repository: "demo/acme-api", number: 42, url: GH, first_seen_at: T(0), opened_here: 1 }]);
  });

  it("records nothing for garbage values or a session without git activity", () => {
    const { ingest, prs, branches } = setup();
    ingest(
      "s5",
      jsonl(
        prompt,
        prLink(1, "42", "javascript:alert(1)", 5),
        prLink(2, -1, null, "o/r"),
        ...bash(1, "g1", { push: { branch: 3 }, pr: "nope" }),
        ...bash(2, "g2", "string"),
        ...bash(3, "g3", { commit: { sha: "abc", kind: "committed" } }),
      ),
    );
    ingest("s6", jsonl(prompt));
    expect(prs("s5")).toEqual([]);
    expect(branches("s5")).toEqual([]);
    expect(prs("s6")).toEqual([]);
    expect(branches("s6")).toEqual([]);
  });

  it("leaves refs on history copied from another session with the session that owns it", () => {
    const { ingest, prs } = setup();
    const created = bash(1, "create", { pr: { number: 42, url: GH, action: "created" } });
    ingest("origin", jsonl(prompt, ...created));
    ingest("copy", jsonl({ ...prompt, uuid: "prompt-2" }, ...created));
    expect(prs("origin")).toHaveLength(1);
    expect(prs("copy")).toEqual([]);
  });
});
