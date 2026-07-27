/**
 * Transcript payload parsers (transcript/parse.ts) — the tool-input/tool-result JSON parsers and the
 * `<command-*>` / `<task-notification>` markup readers. Every one of them is total: malformed input must
 * return null/empty (the caller falls back to the generic tool chip) and never throw. These pin that
 * contract plus the field-level shaping. Imports SOURCE (web has no per-module dist).
 */
import { describe, it, expect } from "vitest";
import {
  parseAnswers,
  parseBashInput,
  parseCommand,
  parseEditInput,
  parsePlan,
  parseQuestions,
  parseTaskNotification,
  previewLabel,
  splitPath,
} from "../src/transcript/parse";

describe("parsePlan", () => {
  it("returns the plan markdown", () => {
    expect(parsePlan(JSON.stringify({ plan: "# Plan\ndo it" }))).toBe("# Plan\ndo it");
  });

  it("returns null for null, malformed JSON, a non-string plan, or a blank plan", () => {
    expect(parsePlan(null)).toBeNull();
    expect(parsePlan("{not json")).toBeNull();
    expect(parsePlan("{}")).toBeNull();
    expect(parsePlan(JSON.stringify({ plan: 42 }))).toBeNull();
    expect(parsePlan(JSON.stringify({ plan: "   " }))).toBeNull();
  });
});

describe("parseBashInput", () => {
  it("extracts the command and the optional flags", () => {
    expect(
      parseBashInput(
        JSON.stringify({ command: "ls", description: "list", timeout: 5000, run_in_background: true, restart: true }),
      ),
    ).toEqual({ command: "ls", description: "list", timeout: 5000, run_in_background: true, restart: true });
  });

  it("defaults the boolean flags to false and leaves absent fields undefined", () => {
    expect(parseBashInput(JSON.stringify({ command: "ls" }))).toEqual({
      command: "ls",
      description: undefined,
      timeout: undefined,
      run_in_background: false,
      restart: false,
    });
  });

  it("ignores flags of the wrong type rather than passing them through", () => {
    const out = parseBashInput(JSON.stringify({ command: "ls", description: 7, timeout: "5s", run_in_background: "yes" }));
    expect(out).toMatchObject({ description: undefined, timeout: undefined, run_in_background: false });
  });

  it("returns null when there is no usable command", () => {
    expect(parseBashInput(null)).toBeNull();
    expect(parseBashInput("{not json")).toBeNull();
    expect(parseBashInput("null")).toBeNull();
    expect(parseBashInput(JSON.stringify({}))).toBeNull();
    expect(parseBashInput(JSON.stringify({ command: "   " }))).toBeNull();
    expect(parseBashInput(JSON.stringify({ command: 12 }))).toBeNull();
  });
});

describe("parseEditInput", () => {
  it("turns an Edit into a single old→new hunk with counted adds/dels", () => {
    const out = parseEditInput("Edit", JSON.stringify({ file_path: "/a.ts", old_string: "a\nb", new_string: "a\nc" }));
    expect(out).toMatchObject({ file_path: "/a.ts", kind: "Edit", adds: 1, dels: 1 });
    expect(out!.hunks).toHaveLength(1);
  });

  it("turns a Write into one all-additions hunk", () => {
    const out = parseEditInput("Write", JSON.stringify({ file_path: "/a.ts", content: "x\ny" }));
    expect(out).toMatchObject({ kind: "Write", adds: 2, dels: 0 });
    expect(out!.hunks[0].every((l) => l.type === "add")).toBe(true);
  });

  it("treats a Write of empty content as one empty hunk", () => {
    const out = parseEditInput("Write", JSON.stringify({ file_path: "/a.ts", content: "" }));
    expect(out).toMatchObject({ adds: 0, dels: 0 });
    expect(out!.hunks).toEqual([[]]);
  });

  it("turns a MultiEdit into one hunk per edit and sums the counts", () => {
    const out = parseEditInput(
      "MultiEdit",
      JSON.stringify({
        file_path: "/a.ts",
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "c", new_string: "d" },
        ],
      }),
    );
    expect(out).toMatchObject({ kind: "MultiEdit", adds: 2, dels: 2 });
    expect(out!.hunks).toHaveLength(2);
  });

  it("skips malformed entries inside a MultiEdit", () => {
    const out = parseEditInput(
      "MultiEdit",
      JSON.stringify({ file_path: "/a.ts", edits: [{ old_string: "a", new_string: "b" }, { nope: 1 }] }),
    );
    expect(out!.hunks).toHaveLength(1);
  });

  it("returns null when a MultiEdit has no usable edits", () => {
    expect(parseEditInput("MultiEdit", JSON.stringify({ file_path: "/a.ts", edits: [] }))).toBeNull();
    expect(parseEditInput("MultiEdit", JSON.stringify({ file_path: "/a.ts", edits: [{ nope: 1 }] }))).toBeNull();
    expect(parseEditInput("MultiEdit", JSON.stringify({ file_path: "/a.ts", edits: "no" }))).toBeNull();
  });

  it("returns null when the payload is unusable", () => {
    expect(parseEditInput("Edit", null)).toBeNull();
    expect(parseEditInput("Edit", "{not json")).toBeNull();
    expect(parseEditInput("Edit", JSON.stringify({ old_string: "a", new_string: "b" }))).toBeNull(); // no file_path
    expect(parseEditInput("Edit", JSON.stringify({ file_path: "/a.ts", old_string: "a" }))).toBeNull();
    expect(parseEditInput("Write", JSON.stringify({ file_path: "/a.ts" }))).toBeNull();
  });

  it("routes any non-Write/MultiEdit tool name through the Edit shape", () => {
    const out = parseEditInput("NotEdit", JSON.stringify({ file_path: "/a.ts", old_string: "a", new_string: "b" }));
    expect(out).toMatchObject({ kind: "NotEdit", adds: 1, dels: 1 });
  });
});

describe("parseQuestions", () => {
  it("returns the questions array", () => {
    const qs = [{ question: "Which?", options: [{ label: "A" }] }];
    expect(parseQuestions(JSON.stringify({ questions: qs }))).toEqual(qs);
  });

  it("returns an empty array for null, malformed JSON, or a non-array", () => {
    expect(parseQuestions(null)).toEqual([]);
    expect(parseQuestions("{not json")).toEqual([]);
    expect(parseQuestions("{}")).toEqual([]);
    expect(parseQuestions(JSON.stringify({ questions: "A" }))).toEqual([]);
  });
});

describe("parseAnswers", () => {
  it("returns the answers and annotations keyed by question text", () => {
    const payload = { answers: { "Which?": "A" }, annotations: { "Which?": { notes: "because" } } };
    expect(parseAnswers(JSON.stringify(payload))).toEqual(payload);
  });

  it("defaults annotations to empty when only answers are present", () => {
    expect(parseAnswers(JSON.stringify({ answers: { q: ["A", "B"] } }))).toEqual({
      answers: { q: ["A", "B"] },
      annotations: {},
    });
  });

  it("returns empties for a pre-capture prose summary, null, or JSON without answers", () => {
    expect(parseAnswers(null)).toEqual({ answers: {}, annotations: {} });
    expect(parseAnswers("The user picked A.")).toEqual({ answers: {}, annotations: {} });
    expect(parseAnswers("{}")).toEqual({ answers: {}, annotations: {} });
  });
});

describe("parseCommand", () => {
  it("reads a slash-command invocation and its args", () => {
    expect(parseCommand("<command-name>/loop</command-name><command-args>5m</command-args>")).toEqual({
      kind: "invocation",
      name: "/loop",
      args: "5m",
    });
  });

  it("prefixes a bare command name with a slash and defaults missing args to empty", () => {
    expect(parseCommand("<command-name>loop</command-name>")).toEqual({ kind: "invocation", name: "/loop", args: "" });
  });

  it("reads local command output from any of the stdout/stderr/output tags", () => {
    expect(parseCommand("<local-command-stdout>  hi  </local-command-stdout>")).toEqual({ kind: "output", stdout: "hi" });
    expect(parseCommand("<local-command-stderr>boom</local-command-stderr>")).toEqual({ kind: "output", stdout: "boom" });
    expect(parseCommand("<command-output>ok</command-output>")).toEqual({ kind: "output", stdout: "ok" });
  });

  it("reads an empty output tag as an empty stdout rather than no match", () => {
    expect(parseCommand("<local-command-stdout></local-command-stdout>")).toEqual({ kind: "output", stdout: "" });
  });

  it("recognizes the caveat marker", () => {
    expect(parseCommand("<local-command-caveat>whatever</local-command-caveat>")).toEqual({ kind: "caveat" });
  });

  it("returns null for ordinary prose", () => {
    expect(parseCommand("just a normal message")).toBeNull();
  });
});

describe("parseTaskNotification", () => {
  it("picks the inner tags out of a notification", () => {
    const text =
      "<task-notification><task-id>t1</task-id><tool-use-id>u1</tool-use-id>" +
      "<status>completed</status><summary> did the thing </summary></task-notification>";
    expect(parseTaskNotification(text)).toEqual({
      taskId: "t1",
      toolUseId: "u1",
      status: "completed",
      summary: "did the thing",
    });
  });

  it("nulls the fields that are absent", () => {
    expect(parseTaskNotification("<task-notification><status>failed</status></task-notification>")).toEqual({
      taskId: null,
      toolUseId: null,
      status: "failed",
      summary: null,
    });
  });

  it("returns null when the text is not a notification", () => {
    expect(parseTaskNotification("<task-id>t1</task-id>")).toBeNull();
    expect(parseTaskNotification("plain text")).toBeNull();
  });
});

describe("previewLabel", () => {
  it("collapses a slash-command invocation to a labelled chip", () => {
    expect(previewLabel("<command-name>/loop</command-name><command-args>5m</command-args>")).toBe("⌘ /loop 5m");
    expect(previewLabel("<command-name>/loop</command-name>")).toBe("⌘ /loop");
  });

  it("labels command output and local-command context", () => {
    expect(previewLabel("<local-command-stdout>x</local-command-stdout>")).toBe("⌘ command output");
    expect(previewLabel("<local-command-caveat>note</local-command-caveat>")).toBe("⌘ local command");
  });

  it("labels a task notification by status, falling back when it has none", () => {
    expect(previewLabel("<task-notification><status>completed</status></task-notification>")).toBe("🔔 task completed");
    expect(previewLabel("<task-notification></task-notification>")).toBe("🔔 task notification");
  });

  it("passes ordinary prompt text through unchanged", () => {
    expect(previewLabel("fix the flaky test")).toBe("fix the flaky test");
  });
});

describe("splitPath", () => {
  it("splits a path into a trailing-slash dir and a basename", () => {
    expect(splitPath("/a/b/c.ts")).toEqual({ dir: "/a/b/", base: "c.ts" });
  });

  it("returns an empty dir for a bare filename", () => {
    expect(splitPath("c.ts")).toEqual({ dir: "", base: "c.ts" });
  });

  it("handles a trailing slash as an empty basename", () => {
    expect(splitPath("/a/b/")).toEqual({ dir: "/a/b/", base: "" });
  });
});
