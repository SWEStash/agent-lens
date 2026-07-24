/**
 * Per-model token-usage aggregation + cost, shared by the session detail, workflow detail, session
 * list, and dashboard queries — the `SELECT model, SUM(...) …` shape and its cache-aware cost roll-up
 * were copy-pasted at 6+ sites (SLOP-036). Keep the column aliases (`i/o/cw/cr`) and the pricing call
 * in one place so a pricing or column change is a single edit.
 */
import { costForUsage } from "@agent-lens/core";
import { type DB } from "./db.js";
import { queryAll } from "./sql-util.js";

/** A per-model token-usage aggregate row: input / output / cache-write / cache-read sums. */
export interface UsageRow {
  model: string | null;
  i: number;
  o: number;
  cw: number;
  cr: number;
}

/** The token categories, kept split so the UI can show input/output/cache-write/cache-read separately. */
export interface TokenSplit {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
}

/** The `SUM(...)` column list every usage query shares (aliased i/o/cw/cr). */
export const USAGE_SUMS =
  "SUM(input_tokens) i, SUM(output_tokens) o, SUM(cache_creation_input_tokens) cw, SUM(cache_read_input_tokens) cr";

/** Per-model token usage for one session. */
export function sessionUsage(db: DB, sessionId: string): UsageRow[] {
  return queryAll<UsageRow>(db, `SELECT model, ${USAGE_SUMS} FROM token_usage WHERE session_id = ? GROUP BY model`, sessionId);
}

/** Sum the split categories of a set of usage rows into a fresh {@link TokenSplit}. */
export function splitOf(rows: UsageRow[]): TokenSplit {
  const split: TokenSplit = { input: 0, output: 0, cache_creation: 0, cache_read: 0 };
  for (const u of rows) {
    split.input += u.i;
    split.output += u.o;
    split.cache_creation += u.cw;
    split.cache_read += u.cr;
  }
  return split;
}

/** Total tokens (all categories, cache included) for a set of usage rows. */
export function tokensOf(split: TokenSplit): number {
  return split.input + split.output + split.cache_creation + split.cache_read;
}

/** Cache-aware USD cost (per-model rates) for a set of usage rows, rounded to 4dp. */
export function costOf(rows: UsageRow[]): number {
  let cost = 0;
  for (const u of rows) {
    cost += costForUsage(u.model, {
      input_tokens: u.i,
      output_tokens: u.o,
      cache_creation_input_tokens: u.cw,
      cache_read_input_tokens: u.cr,
    });
  }
  return Number(cost.toFixed(4));
}
