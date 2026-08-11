/**
 * The CLI's error boundary, exercised by running the BUILT binary the way a user would.
 *
 * Regression: bad input used to escape as an unhandled exception, so `agent-lens service install
 * nonsense` answered a typo with a Node stack trace. The message was always fine — nothing caught
 * it. These assertions pin the *absence of a stack* as much as the message, since that is what
 * silently comes back if the boundary is ever removed.
 *
 * Spawning the real binary (rather than importing) is the point: the boundary is process-level —
 * `process.exit`, an `unhandledRejection` handler — and none of that is observable in-process.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "agent-lens.js");

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    // A clean environment: the developer's own AGENT_LENS_* must not steer these cases.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
  });
  return { status: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

/** A V8 stack frame — the thing users should never be shown for their own typo. */
const STACK_FRAME = /\n\s+at /;

describe("CLI error boundary", () => {
  const cases: Array<[string, string[], Record<string, string>, RegExp]> = [
    ["an unknown service target", ["service", "install", "nonsense"], {}, /invalid target 'nonsense'/],
    ["a malformed --times", ["service", "install", "--times", "abc"], {}, /invalid hours 'abc'/],
    ["a non-numeric port", ["config"], { AGENT_LENS_PORT: "abc" }, /invalid port from AGENT_LENS_PORT/],
  ];

  for (const [name, args, env, expected] of cases) {
    it(`reports ${name} as one line and exits 1`, () => {
      const { status, stderr } = run(args, env);
      expect(status).toBe(1);
      expect(stderr).toMatch(expected);
      expect(stderr).toMatch(/^agent-lens: /);
      expect(stderr).not.toMatch(STACK_FRAME);
    });
  }

  it("prefixes the message exactly once", () => {
    // validatePort's message used to carry its own "agent-lens:" prefix, which the boundary would
    // then double up.
    const { stderr } = run(["config"], { AGENT_LENS_PORT: "abc" });
    expect(stderr.match(/agent-lens:/g)).toHaveLength(1);
  });

  it("reports a misconfigured sources file without a stack", () => {
    // The likeliest first-run failure: a config file that parses but configures nothing.
    const { status, stderr } = run(["collect"], {
      AGENT_LENS_CONFIG: join(dirname(fileURLToPath(import.meta.url)), "fixtures", "empty-sources.json"),
    });
    expect(status).toBe(1);
    expect(stderr).toMatch(/^agent-lens: no valid sources configured/);
    expect(stderr).not.toMatch(STACK_FRAME);
  });
});
