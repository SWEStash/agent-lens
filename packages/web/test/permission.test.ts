import { describe, it, expect } from "vitest";
import type { PermissionDecision } from "../src/api";
import { permissionLabel, APPROVAL_OPTIONS } from "../src/permission";

const p = (o: Partial<PermissionDecision>): PermissionDecision => ({ decision: "accept", via: "other", scope: null, rule_source: null, reason: null, ...o });

describe("permissionLabel (ADR-040)", () => {
  it("is null when nothing was recorded", () => {
    expect(permissionLabel(null)).toBeNull();
  });

  it("names who approved, with a user grant's lifetime", () => {
    expect(permissionLabel(p({ via: "user", scope: "once" }))?.text).toBe("approved by you, once");
    expect(permissionLabel(p({ via: "user", scope: "session" }))?.text).toBe("approved by you, for the session");
    expect(permissionLabel(p({ via: "classifier" }))?.text).toBe("allowed by classifier");
    expect(permissionLabel(p({ via: "other" }))?.text).toBe("allowed by settings");
  });

  it("names who rejected, and marks it as a rejection", () => {
    const l = permissionLabel(p({ decision: "reject", via: "hook", reason: "hook:PreToolUse" }));
    expect(l).toMatchObject({ text: "rejected by hook", rejected: true });
    expect(l?.title).toContain("hook:PreToolUse");
  });

  it("puts the rule source and reason code in the tooltip", () => {
    const l = permissionLabel(p({ via: "rule", rule_source: "projectSettings", reason: "rule:projectSettings" }));
    expect(l?.text).toBe("allowed by rule");
    expect(l?.title).toContain("projectSettings");
  });
});

describe("APPROVAL_OPTIONS", () => {
  it("offers every bucket the API accepts, once", () => {
    const values = APPROVAL_OPTIONS.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values.sort()).toEqual(["classifier", "hook", "mode", "other", "rejected", "rule", "safety_check", "unknown", "user"]);
  });
});
