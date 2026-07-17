/**
 * Tool-error classification — the buckets and the failure-vs-rejection split are a heuristic over
 * Claude Code's `is_error` result text (the API carries no reason field), so these tests pin the
 * mapping against real result_summary snippets sampled from the corpus. Rejections must classify as
 * `kind: "rejection"` (a human/guardrail stopped the call) and never as an agent failure.
 */
import { describe, it, expect } from "vitest";
import { classifyToolError, ERROR_CLASSIFIER_VERSION } from "../dist/errors.js";

describe("classifyToolError", () => {
  const cases: Array<[string, string, string]> = [
    // [result_summary snippet, expected type, expected kind]
    ["<tool_use_error>String to replace not found in file. String: `foo`", "string-not-found", "failure"],
    ["Exit code 1 Traceback (most recent call last): ...", "command-failed", "failure"],
    ["Exit code 2 npm error ENOENT: no such file", "command-failed", "failure"],
    ["File content (29374 tokens) exceeds maximum allowed tokens (25000).", "token-limit", "failure"],
    ["File does not exist. Note: your current working directory is /home/x", "file-state", "failure"],
    ["EISDIR: illegal operation on a directory, read '/home/x/swagger'", "file-state", "failure"],
    ["<tool_use_error>File has not been read yet. Read it first before writing.</tool_use_error>", "file-state", "failure"],
    ["<tool_use_error>File has been modified since read, either by the user or by a linter.", "file-state", "failure"],
    ["[Request interrupted by user for tool use]", "user-rejected", "rejection"],
    ["The user doesn't want to proceed with this tool use. The tool use was rejected", "user-rejected", "rejection"],
    ["<tool_use_error>Cancelled: parallel tool call Bash(cd /home/x)", "user-rejected", "rejection"],
    ["<tool_use_error>Blocked: sleep 45 followed by: echo done. To wait for a condition, use Monitor", "guardrail-blocked", "rejection"],
  ];

  for (const [snippet, type, kind] of cases) {
    it(`classifies "${snippet.slice(0, 40)}…" → ${type}/${kind}`, () => {
      expect(classifyToolError(snippet)).toEqual({ type, kind });
    });
  }

  it("defaults an unmatched error to other/failure", () => {
    expect(classifyToolError("some unrecognized error text")).toEqual({ type: "other", kind: "failure" });
    expect(classifyToolError(null)).toEqual({ type: "other", kind: "failure" });
    expect(classifyToolError("")).toEqual({ type: "other", kind: "failure" });
  });

  it("checks rejection patterns before failure patterns (a rejected Bash call is a rejection, not command-failed)", () => {
    // A rejection message that also names a command must not fall through to command-failed.
    expect(classifyToolError("The tool use was rejected. Exit code would have been 1").kind).toBe("rejection");
  });

  it("exposes a version constant", () => {
    expect(ERROR_CLASSIFIER_VERSION).toBeGreaterThanOrEqual(1);
  });
});
