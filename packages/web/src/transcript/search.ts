/** In-transcript text search. Pure, no JSX and no DOM — see search.test.ts.
 *
 * The whole session is already client-side (one `/sessions/:id` fetch), so finding a term inside it
 * needs no server round-trip. Matching is a case-insensitive literal substring, deliberately unlike
 * the sessions list's token-AND FTS (packages/server/src/db.ts:toFtsQuery): in-page find is expected
 * to behave like the browser's, hitting mid-word so `AWS_SECRET` is found inside `export AWS_SECRET=`.
 */
import type { EventNode, ToolCall } from "../api";

/** Below this a query matches nearly every message, which paints the whole transcript for nothing. */
export const MIN_QUERY = 2;

export interface SearchHit {
  /** The matching event — also its `#ev-<uuid>` anchor and scroll target. */
  uuid: string;
  turnId: string | null;
  /** Occurrences within this message, across every searched field. */
  count: number;
}

export interface SearchModel {
  /** Matching messages in transcript order — the navigation ring. */
  hits: SearchHit[];
  /** turn id → matching messages in it, for the collapsed turn header badge. */
  byTurn: Map<string, number>;
  /** Matching messages, i.e. `hits.length`. Not occurrences: navigation steps per message. */
  total: number;
}

export const EMPTY_MODEL: SearchModel = { hits: [], byTurn: new Map(), total: 0 };

/** The searchable text of one message, flattened: the body, the thinking block, and every tool call's
 * input and result. Mirrors what the event renders — tool payloads are where paths and secrets live,
 * which is the whole point of searching an audit transcript. */
function toolText(t: ToolCall): string {
  return [t.input_json, t.result_summary, t.full_result?.text].filter(Boolean).join("\n");
}

function haystack(e: EventNode): string {
  const parts: string[] = [];
  if (e.text) parts.push(e.text);
  if (e.thinking) parts.push(e.thinking);
  for (const t of e.toolCalls) parts.push(toolText(t));
  return parts.join("\n").toLowerCase();
}

/** Lowercased haystacks keyed by event uuid. Built once per session (memoize on the detail) so
 * retyping a query only re-scans, never re-flattens. */
export function buildHaystacks(events: EventNode[]): Map<string, string> {
  return new Map(events.map((e) => [e.uuid, haystack(e)]));
}

/** Occurrences of `needle` in `hay`; both must already be lowercased. */
function countIn(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Which messages contain `query`, in transcript order, with per-turn totals for the header badges.
 * `events` should be the rendered set, so the count never promises a match the reader can't reach. */
export function searchSession(events: EventNode[], haystacks: Map<string, string>, query: string): SearchModel {
  const needle = query.trim().toLowerCase();
  if (needle.length < MIN_QUERY) return EMPTY_MODEL;
  const hits: SearchHit[] = [];
  const byTurn = new Map<string, number>();
  for (const e of events) {
    const count = countIn(haystacks.get(e.uuid) ?? haystack(e), needle);
    if (!count) continue;
    hits.push({ uuid: e.uuid, turnId: e.turn_id ?? null, count });
    if (e.turn_id) byTurn.set(e.turn_id, (byTurn.get(e.turn_id) ?? 0) + 1);
  }
  return { hits, byTurn, total: hits.length };
}

/** Whether this tool call's input or result holds the query. Tool payloads are searched whether or not
 * "hide tool messages" is on — that toggle is about reading the conversation, not about narrowing an
 * audit — so this is what lets a suppressed tool card show itself when navigated to. */
export function toolMatches(t: ToolCall, query: string): boolean {
  return fieldMatches(toolText(t), query);
}

/** Whether one specific field holds the query — used to decide whether to force open the thing hiding
 * it (the thinking toggle, a clamped body) when its message becomes the active match. */
export function fieldMatches(text: string | null | undefined, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!text || needle.length < MIN_QUERY) return false;
  return text.toLowerCase().includes(needle);
}
