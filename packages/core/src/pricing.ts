/**
 * Model pricing for deriving cost from token counts (ADR-003: no cost is stored in traces).
 * USD per 1M tokens. Cache-read is the discounted rate; cache-write the premium rate.
 *
 * Rates are matched by prefix so dated/variant model ids resolve (e.g. 'claude-opus-4-8[1m]').
 * Update as pricing changes; unknown models cost 0 and are reported separately.
 *
 * PRICE_TABLE is the built-in default. A `pricing` block in agent-lens.config.json can override or
 * extend it (ADR-028) — `resolvePricing()` in config.ts builds the merged table and the process
 * entry point installs it with {@link usePricing}, so a model that launches between releases can be
 * priced without one. Cost is still derived at read time, never stored.
 */

export interface Rate {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * Claude Code stamps this on locally-generated messages — no API call was made, so it is correctly
 * unpriced and must never be reported as a missing rate. Excluded wherever unpriced models are
 * surfaced (ingest report, /api/about, per-session markers).
 */
export const SYNTHETIC_MODEL = "<synthetic>";

/** Model ids with real token usage but no rate in the active table — the "cost is understated" set. */
export function unpricedModels(models: Iterable<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const m of models) {
    if (m && m !== SYNTHETIC_MODEL && !rateForModel(m)) out.add(m);
  }
  return [...out].sort();
}

export interface UsageTokens {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/**
 * Prefix → rate. Longest matching prefix wins, so dated/variant ids resolve to the most specific
 * entry (e.g. 'claude-opus-4-8' beats the legacy 'claude-opus-4' fallback).
 * USD per 1M tokens. Convention: cacheWrite (5-minute) = 1.25× input, cacheRead = 0.1× input.
 */
export const PRICE_TABLE: Record<string, Rate> = {
  // Opus 4.0 / 4.1 launched at $15/$75; Opus 4.5 cut the Opus tier to $5/$25 and 4.6/4.7/4.8 kept it.
  // The bare 'claude-opus-4' fallback stays at the legacy rate for 4.0/4.1; 4.5+ override below.
  "claude-opus-4": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-4-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-fable-5": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1.0 },
  "claude-sonnet-4": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  // Sonnet 5 list price. An introductory $2/$10 rate runs through 2026-08-31; we bill the list
  // price so the estimate doesn't silently change under a date, matching the "list price" label.
  "claude-sonnet-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  "claude-3-5-sonnet": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
};

/** Cache-rate convention when an override gives only input/output — mirrors the PRICE_TABLE entries. */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export interface MergedPricing {
  table: Record<string, Rate>;
  /** Keys rejected as malformed. Reported, never applied — a typo must not silently reprice a model. */
  invalid: string[];
  /** Keys that were accepted, so callers can report "N overrides in force" without diffing tables. */
  applied: string[];
}

function toRate(v: unknown): Rate | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const num = (x: unknown): number | null =>
    typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null;
  const input = num(o.input);
  const output = num(o.output);
  if (input === null || output === null) return null;
  // Optional keys must be valid *if present* — a mistyped cacheRead falls back to the convention
  // silently otherwise, which is the same class of bug as the missing entry this all came from.
  if (o.cacheWrite !== undefined && num(o.cacheWrite) === null) return null;
  if (o.cacheRead !== undefined && num(o.cacheRead) === null) return null;
  return {
    input,
    output,
    cacheWrite: num(o.cacheWrite) ?? input * CACHE_WRITE_MULTIPLIER,
    cacheRead: num(o.cacheRead) ?? input * CACHE_READ_MULTIPLIER,
  };
}

/**
 * Overlay user-supplied rates on a base table, by exact prefix key. Pure: the caller decides what to
 * do with `invalid` (we warn and keep the built-in rate — cost is a labelled estimate, so a typo in
 * an optional block must not stop the tool from running).
 */
export function mergePricing(base: Record<string, Rate>, overrides: unknown): MergedPricing {
  const table = { ...base };
  const invalid: string[] = [];
  const applied: string[] = [];
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    return { table, invalid, applied };
  }
  for (const [prefix, value] of Object.entries(overrides as Record<string, unknown>)) {
    const rate = toRate(value);
    if (!prefix.trim() || !rate) invalid.push(prefix);
    else {
      table[prefix] = rate;
      applied.push(prefix);
    }
  }
  return { table, invalid: invalid.sort(), applied: applied.sort() };
}

/**
 * The table `rateForModel` reads. Process-wide and set once at startup by the CLI entry points, so
 * the ~6 cost call sites keep their signatures and no table has to be threaded through the server's
 * query layer. Tests that install a table must restore PRICE_TABLE afterwards.
 */
let activeTable: Record<string, Rate> = PRICE_TABLE;

/** Install the effective price table (built-in defaults merged with config overrides). */
export function usePricing(table: Record<string, Rate>): void {
  activeTable = table;
}

/** The table currently in force — for diagnostics (`agent-lens config`, /api/about). */
export function activePricing(): Record<string, Rate> {
  return activeTable;
}

export function rateForModel(model: string | null | undefined): Rate | null {
  if (!model) return null;
  let best: { len: number; rate: Rate } | null = null;
  for (const [prefix, rate] of Object.entries(activeTable)) {
    if (model.startsWith(prefix) && (!best || prefix.length > best.len)) {
      best = { len: prefix.length, rate };
    }
  }
  return best?.rate ?? null;
}

/** Cost in USD for one usage record. Returns 0 for unknown models. */
export function costForUsage(model: string | null | undefined, u: UsageTokens): number {
  const r = rateForModel(model);
  if (!r) return 0;
  const M = 1_000_000;
  return (
    (u.input_tokens * r.input +
      u.output_tokens * r.output +
      u.cache_creation_input_tokens * r.cacheWrite +
      u.cache_read_input_tokens * r.cacheRead) /
    M
  );
}
