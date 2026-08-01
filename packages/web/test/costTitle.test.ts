/**
 * The hover text behind every cost figure (ADR-028).
 *
 * "$0" next to real token usage reads as "this was free", which is how a week of unpriced Opus 5
 * sessions went unnoticed. The tooltip is where the number admits it is incomplete, so its two
 * branches — priced and not — are pinned here rather than left to the components that render them.
 */
import { describe, expect, it } from "vitest";
import { costTitle, fmtCost } from "../src/format";

describe("costTitle", () => {
  it("states the basis when everything in scope is priced", () => {
    for (const priced of [undefined, null, []]) {
      expect(costTitle(priced)).toBe("Estimated at API list prices (cache-aware)");
    }
  });

  it("names the unpriced models and says the total is incomplete", () => {
    const t = costTitle(["claude-opus-5"]);
    expect(t).toContain("claude-opus-5");
    expect(t).toContain("incomplete");
    expect(t).not.toContain("Estimated at API list prices"); // the basis claim would be a lie here
  });

  it("lists every unpriced model, so the fix is actionable without a second lookup", () => {
    expect(costTitle(["claude-alpha-1", "claude-zeta-9"])).toContain("claude-alpha-1, claude-zeta-9");
  });

  it("points at the config key that fixes it", () => {
    expect(costTitle(["claude-zeta-9"])).toContain("pricing");
  });
});

describe("fmtCost — what the marker sits next to", () => {
  it("renders a true zero as $0, which is why the unpriced case needs its own signal", () => {
    expect(fmtCost(0)).toBe("$0");
    expect(fmtCost(0.004)).toBe("<$0.01");
    expect(fmtCost(1.5)).toBe("$1.50");
  });
});
