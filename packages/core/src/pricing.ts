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
 * USD per 1M tokens, from the published pricing page. Convention: cacheWrite (5-minute) = 1.25× input,
 * cacheRead = 0.1× input — except Opus 5.5 / Sonnet 5.5 (cache reads at 0.05×) and Fable 5.1 (0.025×).
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
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-fable-5": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1.0 },
  "claude-fable-5-1": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  "claude-sonnet-4": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  // Sonnet 5 launched at an "introductory" $2/$10 that was later made its standard price; the
  // announced rise to $3/$15 was cancelled.
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  "claude-haiku-4": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  // Haiku 5.5 is tiered by prompt size: these are the rates up to 100K prompt tokens. Prompts over
  // 100K bill at 5× ($0.50/$2.50), which this cannot apply: cost is derived from per-model token
  // sums, after the per-request size is gone. Long-prompt Haiku 5.5 spend is therefore understated.
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
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

/**
 * A trailing `-YYYYMMDD` marks a dated snapshot of a minor version, and the minor version is the
 * identity — `claude-haiku-4-5-20251001` and `claude-haiku-4-5` are one model. Transcripts carry
 * whichever id the client happened to send, so grouping and filtering canonicalize here first; the
 * raw id stays in storage, the only place full fidelity survives (ADR-037).
 *
 * Deliberately narrow. The minor version is never stripped (`opus-4-8` and `opus-4-7` are different
 * models), the `[1m]` context variant keeps its own key (different price point), and `<synthetic>`
 * carries no date so it passes through untouched.
 *
 * The SQL twin is `canonModelSql` in the server's sql-util; `canonical-model.test.ts` asserts the
 * two agree. Note this is NOT applied before {@link rateForModel} — pricing resolves the raw id, so
 * a dated override key in a config table keeps working.
 */
const DATED_SNAPSHOT = /-\d{8}$/;
export function canonicalModel<T extends string | null | undefined>(model: T): T {
  return (model && DATED_SNAPSHOT.test(model) ? model.slice(0, -9) : model) as T;
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
