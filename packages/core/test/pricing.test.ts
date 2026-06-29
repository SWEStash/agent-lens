/**
 * Pricing — cost is derived, never stored (ADR-003), so its correctness rides entirely on this
 * table + the longest-prefix match. These tests pin OUR contract: which rate a (possibly dated /
 * variant) model id resolves to, that cache-write/cache-read use their own rates, and that an
 * unknown model costs 0 (and is therefore reported as unpriced elsewhere). Hand-computed expecteds.
 */
import { describe, it, expect } from "vitest";
import { rateForModel, costForUsage } from "../dist/pricing.js";

const zero = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

describe("rateForModel — longest matching prefix wins", () => {
  it("resolves an exact base id", () => {
    expect(rateForModel("claude-opus-4-8")?.input).toBe(5);
  });

  it("a dated/variant id resolves to the most specific prefix, not the legacy fallback", () => {
    // 'claude-opus-4-8[1m]' must hit opus-4-8 ($5), NOT the bare 'claude-opus-4' legacy ($15).
    expect(rateForModel("claude-opus-4-8[1m]")?.input).toBe(5);
    // A real dated id seen in the corpus.
    const haiku = rateForModel("claude-haiku-4-5-20251001");
    expect(haiku).toEqual({ input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 });
  });

  it("an Opus 4.x with no specific entry falls back to the legacy claude-opus-4 rate", () => {
    expect(rateForModel("claude-opus-4-1")?.input).toBe(15); // no 4-1 entry → bare 'claude-opus-4'
  });

  it("unknown / null / the literal <synthetic> model → no rate", () => {
    expect(rateForModel("<synthetic>")).toBeNull();
    expect(rateForModel("gpt-4o")).toBeNull();
    expect(rateForModel(null)).toBeNull();
    expect(rateForModel(undefined)).toBeNull();
  });
});

describe("costForUsage — USD per 1M tokens, cache rates applied separately", () => {
  it("sums each token class at its own rate (1M of each on opus-4-8)", () => {
    // (1M*5 + 1M*25 + 1M*6.25 + 1M*0.5) / 1M = 36.75
    const cost = costForUsage("claude-opus-4-8", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(36.75, 10);
  });

  it("charges cache-read at the discounted rate (the dominant token class in real data)", () => {
    // 10M cache-read on opus-4-8 @ $0.5/1M = $5.00 exactly; nothing else set.
    expect(costForUsage("claude-opus-4-8", { ...zero, cache_read_input_tokens: 10_000_000 })).toBeCloseTo(5.0, 10);
  });

  it("an unknown / unpriced model costs 0 regardless of token volume", () => {
    expect(costForUsage("<synthetic>", { input_tokens: 9e9, output_tokens: 9e9, cache_creation_input_tokens: 9e9, cache_read_input_tokens: 9e9 })).toBe(0);
    expect(costForUsage(null, { ...zero, input_tokens: 1000 })).toBe(0);
  });
});
