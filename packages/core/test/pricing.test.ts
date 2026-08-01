/**
 * Pricing — cost is derived, never stored (ADR-003), so its correctness rides entirely on this
 * table + the longest-prefix match. These tests pin OUR contract: which rate a (possibly dated /
 * variant) model id resolves to, that cache-write/cache-read use their own rates, and that an
 * unknown model costs 0 (and is therefore reported as unpriced elsewhere). Hand-computed expecteds.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  rateForModel,
  costForUsage,
  mergePricing,
  usePricing,
  activePricing,
  unpricedModels,
  PRICE_TABLE,
  SYNTHETIC_MODEL,
} from "../dist/pricing.js";

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

  it("the Claude 5 family is priced (a missing entry silently reports $0, not an error)", () => {
    // Regression: opus-5/sonnet-5 were absent, so every session recorded after the CLI moved to
    // them derived a $0 cost. Nothing throws on a missing rate — only these assertions catch it.
    expect(rateForModel("claude-opus-5")).toEqual({ input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 });
    expect(rateForModel("claude-sonnet-5")).toEqual({ input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 });
    expect(rateForModel("claude-fable-5")?.input).toBe(10);
    // The '5' families must not be captured by the legacy 'claude-opus-4'/'claude-sonnet-4' prefixes.
    expect(rateForModel("claude-opus-5")?.input).not.toBe(15);
    expect(rateForModel("claude-sonnet-5[1m]")?.input).toBe(3);
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

/**
 * Config overrides (ADR-028) are the escape hatch for the staleness this file's other tests pin: a
 * model that launches between releases can be priced without one. The contract is that a valid entry
 * wins over the built-in, and an invalid one is reported rather than applied — silently repricing a
 * model from a typo would be the same failure mode as not pricing it at all.
 */
describe("mergePricing — config overrides over the built-in table", () => {
  it("an override replaces the built-in rate for that prefix", () => {
    const { table, applied, invalid } = mergePricing(PRICE_TABLE, {
      "claude-opus-5": { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 },
    });
    expect(table["claude-opus-5"]).toEqual({ input: 1, output: 2, cacheWrite: 3, cacheRead: 4 });
    expect(applied).toEqual(["claude-opus-5"]);
    expect(invalid).toEqual([]);
    expect(PRICE_TABLE["claude-opus-5"].input).toBe(5); // base table not mutated
  });

  it("a partial entry derives cache rates from the documented 1.25x / 0.1x convention", () => {
    const { table } = mergePricing(PRICE_TABLE, { "claude-opus-5": { input: 8, output: 40 } });
    expect(table["claude-opus-5"]).toEqual({ input: 8, output: 40, cacheWrite: 10, cacheRead: 0.8 });
  });

  it("an unknown prefix adds a new priced model rather than being ignored", () => {
    const { table, applied } = mergePricing(PRICE_TABLE, { "claude-future-9": { input: 2, output: 4 } });
    expect(applied).toEqual(["claude-future-9"]);
    expect(table["claude-future-9"].output).toBe(4);
  });

  it("malformed entries are reported and dropped, leaving the built-in rate in force", () => {
    const { table, invalid, applied } = mergePricing(PRICE_TABLE, {
      "claude-opus-5": { input: "5", output: 25 },      // wrong type
      "claude-sonnet-5": { input: 3 },                   // missing output
      "claude-haiku-4": { input: -1, output: 5 },        // negative
      "claude-fable-5": { input: 10, output: 50, cacheRead: "cheap" }, // bad optional key
      "claude-opus-4-8": "free",                          // not an object
    });
    expect(invalid).toEqual([
      "claude-fable-5", "claude-haiku-4", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-5",
    ]);
    expect(applied).toEqual([]);
    expect(table["claude-opus-5"].input).toBe(5); // built-in retained, not zeroed
    expect(table["claude-opus-4-8"].input).toBe(5);
  });

  it("a missing or non-object pricing block is simply the built-in table", () => {
    for (const bad of [undefined, null, [], "nope", 7]) {
      const { table, applied, invalid } = mergePricing(PRICE_TABLE, bad);
      expect(applied).toEqual([]);
      expect(invalid).toEqual([]);
      expect(table["claude-opus-5"].input).toBe(5);
    }
  });
});

describe("unpricedModels — the 'cost is understated' set", () => {
  afterEach(() => usePricing(PRICE_TABLE));

  it("returns only real models with no rate, deduped and sorted", () => {
    expect(unpricedModels(["claude-opus-5", "gpt-4o", "claude-zeta-9", "gpt-4o", "claude-opus-4-8"]))
      .toEqual(["claude-zeta-9", "gpt-4o"]);
  });

  it("never reports <synthetic> or a null model — neither made an API call", () => {
    expect(unpricedModels([SYNTHETIC_MODEL, null, undefined, ""])).toEqual([]);
  });

  it("follows the active table, so a config override can silence it", () => {
    expect(unpricedModels(["claude-zeta-9"])).toEqual(["claude-zeta-9"]);
    usePricing(mergePricing(PRICE_TABLE, { "claude-zeta-9": { input: 1, output: 2 } }).table);
    expect(unpricedModels(["claude-zeta-9"])).toEqual([]);
  });
});

describe("usePricing — the active table backs rateForModel", () => {
  afterEach(() => usePricing(PRICE_TABLE));

  it("installs the merged table for every downstream cost call", () => {
    const { table } = mergePricing(PRICE_TABLE, { "claude-opus-5": { input: 0, output: 0 } });
    usePricing(table);
    expect(rateForModel("claude-opus-5")?.input).toBe(0);
    // 1M input tokens at the overridden $0 rate.
    expect(costForUsage("claude-opus-5", { ...zero, input_tokens: 1_000_000 })).toBe(0);
    // A model with no override still resolves from the built-in half of the merged table.
    expect(rateForModel("claude-opus-4-8")?.input).toBe(5);
  });

  it("restoring PRICE_TABLE undoes an override", () => {
    usePricing(mergePricing(PRICE_TABLE, { "claude-opus-5": { input: 99, output: 99 } }).table);
    expect(rateForModel("claude-opus-5")?.input).toBe(99);
    usePricing(PRICE_TABLE);
    expect(rateForModel("claude-opus-5")?.input).toBe(5);
    expect(activePricing()).toBe(PRICE_TABLE);
  });
});

/**
 * The table only goes stale in one direction: a model ships, transcripts start carrying its id, and
 * nobody adds a rate. The committed corpus is the one model-id set we can check mechanically — when
 * it is refreshed from newer transcripts, this fails instead of quietly deriving $0.
 */
describe("every model id in the committed corpus is priced", () => {
  const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures/corpus");

  function jsonlFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...jsonlFiles(p));
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
    return out;
  }

  it("resolves a rate for each, except the synthetic placeholder", () => {
    const models = new Set<string>();
    for (const f of jsonlFiles(CORPUS)) {
      for (const m of readFileSync(f, "utf8").matchAll(/"model"\s*:\s*"([^"]+)"/g)) models.add(m[1]);
    }
    expect(models.size).toBeGreaterThan(0); // the scan itself must not silently match nothing
    const unpriced = [...models].filter((m) => m !== "<synthetic>" && !rateForModel(m));
    expect(unpriced).toEqual([]);
  });
});
