/**
 * Per-model token-usage aggregation + cost, shared by the session detail, workflow detail, session
 * list, and dashboard queries. Keeping the `SELECT model, SUM(...) …` shape, the column aliases
 * (`i/o/cw/cr`) and the cache-aware cost roll-up in one place makes a pricing or column change a
 * single edit rather than one per call site.
 */
import { costForUsage, unpricedModels } from "@agent-lens/core";
import type { TokenSplit } from "@agent-lens/contracts";
import { type DB } from "./db.js";
import { placeholders, pushGrouped, queryAll } from "./sql-util.js";
import type { UsageRow } from "./rows.js";

export type { UsageRow };

/**
 * The `SUM(...)` column list every usage query shares (aliased i/o/cw/cr). `t` qualifies the columns
 * for a query that joins token_usage under an alias, e.g. `usageSums("t.")`.
 */
export const usageSums = (t = "") =>
  `SUM(${t}input_tokens) i, SUM(${t}output_tokens) o, SUM(${t}cache_creation_input_tokens) cw, SUM(${t}cache_read_input_tokens) cr`;
export const USAGE_SUMS = usageSums();

/** Per-model token usage for one session. */
export function sessionUsage(db: DB, sessionId: string): UsageRow[] {
  return queryAll<UsageRow>(db, `SELECT model, ${USAGE_SUMS} FROM token_usage WHERE session_id = ? GROUP BY model`, sessionId);
}

/**
 * Per-model token usage for many sessions in one pass, keyed by session id (a session with no usage
 * has no entry). Chunked under SQLite's bound-parameter limit: a workflow run can fan out to more
 * agents than any page of the session list holds.
 */
export function usageBySession(db: DB, ids: string[]): Map<string, UsageRow[]> {
  const out = new Map<string, UsageRow[]>();
  const CHUNK = 800;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    for (const { session_id, ...u } of queryAll<UsageRow & { session_id: string }>(
      db,
      `SELECT session_id, model, ${USAGE_SUMS} FROM token_usage
       WHERE session_id IN (${placeholders(batch)}) GROUP BY session_id, model`,
      ...batch,
    )) {
      pushGrouped(out, session_id, u);
    }
  }
  return out;
}

export const zeroSplit = (): TokenSplit => ({ input: 0, output: 0, cache_creation: 0, cache_read: 0 });

/** Add one usage row's categories into `acc`, in place. */
export function addUsage(acc: TokenSplit, u: UsageRow): void {
  acc.input += u.i;
  acc.output += u.o;
  acc.cache_creation += u.cw;
  acc.cache_read += u.cr;
}

/** Sum the split categories of a set of usage rows into a fresh {@link TokenSplit}. */
export function splitOf(rows: UsageRow[]): TokenSplit {
  const split = zeroSplit();
  for (const u of rows) addUsage(split, u);
  return split;
}

/** Total tokens (all categories, cache included) for a set of usage rows. */
export function tokensOf(split: TokenSplit): number {
  return split.input + split.output + split.cache_creation + split.cache_read;
}

/** Whether a usage row records any tokens at all. */
export const hasTokens = (u: UsageRow): boolean => !!(u.i || u.o || u.cw || u.cr);

/**
 * The models in these rows that have real token usage but no rate, so {@link costOf} understates the
 * total. Empty for a fully-priced scope. `<synthetic>` is excluded — it never had an API cost.
 */
export function unpricedOf(rows: UsageRow[]): string[] {
  return unpricedModels(rows.filter(hasTokens).map((u) => u.model));
}

/** Cache-aware USD cost of one usage row at its model's rate, unrounded. */
export function rowCost(u: UsageRow): number {
  return costForUsage(u.model, {
    input_tokens: u.i,
    output_tokens: u.o,
    cache_creation_input_tokens: u.cw,
    cache_read_input_tokens: u.cr,
  });
}

/** Cache-aware USD cost (per-model rates) for a set of usage rows, rounded to 4dp. */
export function costOf(rows: UsageRow[]): number {
  let cost = 0;
  for (const u of rows) cost += rowCost(u);
  return Number(cost.toFixed(4));
}
