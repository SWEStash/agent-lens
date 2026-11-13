/**
 * How each tool call was approved (ADR-040, #76): the Claude Code adapter reads the top-level
 * `permissionDecision` on a tool-result line and normalizes it onto the tool call. Missing means not
 * recorded, so every column stays NULL rather than being guessed.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { SourceFile } from "@agent-lens/core";
import { openDb } from "../dist/db.js";
import { prepareStatements, ingestFile, rebuildDerived, newStats } from "../dist/pipeline.js";
import { ClaudeCodeAdapter } from "../dist/adapters/claude-code.js";
import { jsonl } from "./helpers/seed.js";

const SOURCE = "test";
const AGENT = "claude-code";
const T = (n: number) => `2026-04-01T00:${String(n).padStart(2, "0")}:00.000Z`;

/** One tool call and its result line, the result carrying `pd` as permissionDecision when given. */
function pair(n: number, id: string, pd?: unknown, isError = false): object[] {
  return [
    {
      uuid: `use-${id}`,
      type: "assistant",
      timestamp: T(2 * n),
      message: { role: "assistant", model: "claude-opus-5", content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }] },
    },
    {
      uuid: `res-${id}`,
      type: "user",
      timestamp: T(2 * n + 1),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok", ...(isError ? { is_error: true } : {}) }] },
      ...(pd === undefined ? {} : { permissionDecision: pd }),
    },
  ];
}

const LINES = jsonl(
  { uuid: "prompt", type: "user", timestamp: T(0), cwd: "/tmp/proj", message: { role: "user", content: "go" } },
  ...pair(1, "t-classifier", { decision: "accept", source: "config", reasonType: "classifier" }),
  ...pair(2, "t-user-once", { decision: "accept", source: "user_temporary", grantScope: "once", ruleSource: "localSettings" }),
  ...pair(3, "t-rule", { decision: "accept", source: "config", reasonType: "rule", ruleSource: "projectSettings", reasonCode: "rule:projectSettings" }),
  ...pair(4, "t-hook-reject", { decision: "reject", source: "hook", reasonType: "hook", reasonCode: "hook:PreToolUse" }, true),
  ...pair(5, "t-absent"),
  ...pair(6, "t-config-bare", { decision: "accept", source: "config" }),
  ...pair(7, "t-user-reject", { decision: "reject", source: "user_reject" }, true),
  ...pair(8, "t-future", { decision: "accept", source: "config", reasonType: "somethingNew", reasonCode: 42, classifierCategory: "cat_x" }),
  ...pair(9, "t-subcommands", { decision: "reject", source: "config", reasonType: "subcommandResults", reasonCode: "subcommands:bashMiss:no-rule-match" }, true),
  ...pair(10, "t-garbage", { decision: "maybe", source: "config", reasonType: "classifier" }),
);

let db: ReturnType<typeof openDb>;

beforeAll(() => {
  db = openDb(":memory:");
  const stmts = prepareStatements(db);
  const adapter = new ClaudeCodeAdapter();
  stmts.insAgent.run(AGENT, "Claude Code CLI");
  stmts.insSource.run({ id: SOURCE, label: SOURCE, agent_id: AGENT, config_dir: null });
  const file: SourceFile = { path: "/fixtures/sess-perm.jsonl", sessionId: "sess-perm", encodedDir: "-fixtures", isVersion: false, sourceId: SOURCE };
  ingestFile(db, stmts, adapter, file, LINES.split("\n"), { size: LINES.length, mtimeMs: 0, hash: "h" }, T(0), newStats());
  rebuildDerived(db);
});

const perm = (id: string) =>
  db
    .prepare(
      "SELECT permission_decision decision, permission_via via, permission_scope scope, permission_rule_source rule_source, permission_reason reason FROM tool_calls WHERE id = ?",
    )
    .get(id);

const NONE = { decision: null, via: null, scope: null, rule_source: null, reason: null };

describe("tool call permission decisions (ADR-040)", () => {
  it("records an accept by the auto-mode classifier", () => {
    expect(perm("t-classifier")).toEqual({ decision: "accept", via: "classifier", scope: null, rule_source: null, reason: null });
  });

  it("records an accept by the user, once", () => {
    expect(perm("t-user-once")).toEqual({ decision: "accept", via: "user", scope: "once", rule_source: "localSettings", reason: null });
  });

  it("records an accept by a settings rule, with its source", () => {
    expect(perm("t-rule")).toEqual({ decision: "accept", via: "rule", scope: null, rule_source: "projectSettings", reason: "rule:projectSettings" });
  });

  it("records a reject by a hook", () => {
    expect(perm("t-hook-reject")).toEqual({ decision: "reject", via: "hook", scope: null, rule_source: null, reason: "hook:PreToolUse" });
  });

  it("leaves every column NULL when the result carries no decision", () => {
    expect(perm("t-absent")).toEqual(NONE);
  });

  it("maps an accept from config with no reason type to other", () => {
    expect(perm("t-config-bare")).toMatchObject({ decision: "accept", via: "other" });
  });

  it("records a reject by the user", () => {
    expect(perm("t-user-reject")).toMatchObject({ decision: "reject", via: "user" });
  });

  it("maps an unknown reason type to other and ignores non-string values", () => {
    // reasonCode is not a string, so the next fallback (classifierCategory) supplies the reason.
    expect(perm("t-future")).toEqual({ decision: "accept", via: "other", scope: null, rule_source: null, reason: "cat_x" });
  });

  it("treats per-subcommand rule results as a rule decision", () => {
    expect(perm("t-subcommands")).toMatchObject({ decision: "reject", via: "rule", reason: "subcommands:bashMiss:no-rule-match" });
  });

  it("records nothing when the decision itself is not accept or reject", () => {
    expect(perm("t-garbage")).toEqual(NONE);
  });
});
