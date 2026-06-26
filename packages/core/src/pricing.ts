/**
 * Model pricing for deriving cost from token counts (ADR-003: no cost is stored in traces).
 * USD per 1M tokens. Cache-read is the discounted rate; cache-write the premium rate.
 *
 * Rates are matched by prefix so dated/variant model ids resolve (e.g. 'claude-opus-4-8[1m]').
 * Update as pricing changes; unknown models cost 0 and are reported separately.
 */

export interface Rate {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface UsageTokens {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Prefix → rate. Longest matching prefix wins. */
export const PRICE_TABLE: Record<string, Rate> = {
  "claude-opus-4": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet-4": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  "claude-3-5-sonnet": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
};

export function rateForModel(model: string | null | undefined): Rate | null {
  if (!model) return null;
  let best: { len: number; rate: Rate } | null = null;
  for (const [prefix, rate] of Object.entries(PRICE_TABLE)) {
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
