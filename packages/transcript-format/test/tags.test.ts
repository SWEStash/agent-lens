/**
 * The shared markup vocabulary. These assertions pin the two behaviors the three consumers rely on:
 * telling a command's *output* from a prompt (ingest's turn grouping) and reading a tag's body
 * (the server's workflow completion, web's command and notification cards).
 */
import { describe, it, expect } from "vitest";
import { COMMAND_OUTPUT_TAGS, commandOutput, isCommandResultCarrier, xmlTag } from "../src/index.js";

describe("isCommandResultCarrier", () => {
  it("is true for each command-output tag", () => {
    for (const tag of COMMAND_OUTPUT_TAGS) {
      expect(isCommandResultCarrier(`<${tag}>done</${tag}>`)).toBe(true);
    }
  });

  it("is false for a command invocation, which is a real prompt", () => {
    expect(isCommandResultCarrier("<command-name>/login</command-name>")).toBe(false);
  });

  it("tolerates leading whitespace", () => {
    expect(isCommandResultCarrier("\n  <local-command-stdout>ok</local-command-stdout>")).toBe(true);
  });

  it("is false when a tag is merely quoted mid-message", () => {
    expect(isCommandResultCarrier("as in <local-command-stdout>, which wraps output")).toBe(false);
  });

  it("is false for ordinary prose", () => {
    expect(isCommandResultCarrier("take a look at the ATS compatibility docs")).toBe(false);
  });
});

describe("xmlTag", () => {
  it("returns the trimmed inner content", () => {
    expect(xmlTag("<status>  completed \n</status>", "status")).toBe("completed");
  });

  it("captures a multi-line body whole", () => {
    expect(xmlTag("<summary>line one\nline two</summary>", "summary")).toBe("line one\nline two");
  });

  it("stops at the first closing tag", () => {
    expect(xmlTag("<result>first</result> and <result>second</result>", "result")).toBe("first");
  });

  it("returns null when the tag is absent", () => {
    expect(xmlTag("<status>ok</status>", "summary")).toBeNull();
  });
});

describe("commandOutput", () => {
  it("reads stdout", () => {
    expect(commandOutput("<local-command-stdout>Login successful</local-command-stdout>")).toBe("Login successful");
  });

  it("reads stderr and command-output the same way", () => {
    expect(commandOutput("<local-command-stderr>boom</local-command-stderr>")).toBe("boom");
    expect(commandOutput("<command-output>hi</command-output>")).toBe("hi");
  });

  it("returns null when there is no output tag", () => {
    expect(commandOutput("<command-name>/plugin</command-name>")).toBeNull();
  });
});
