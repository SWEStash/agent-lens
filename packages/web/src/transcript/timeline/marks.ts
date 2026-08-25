/**
 * Turn a session's events into the band's drawable marks.
 *
 * Two things live here rather than in the component: which message TYPE a mark takes its colour from,
 * and which audit annotations hang under it on the rail. The rail is the reason this is agent-lens's
 * timeline and not a generic token chart — the marks worth jumping to are the audit-relevant ones.
 *
 * Pure, so both can be unit-tested without rendering.
 */
import type { EventNode, Finding, FileChangeRow, Severity } from "../../api";
import { workTokens } from "../../format";
import type { TimelinePoint } from "./scale";

/** The five categorical types, plus `meta` for system/command events. `meta` is not in the legend and
 *  not one of the validated colour steps: it draws in the muted ink, like any other aside. */
export type MarkKind = "user" | "assistant" | "thinking" | "tool" | "tool-error" | "meta";

/** Which token number drives mark height. Work is the default for the same reason the dashboard mutes
 *  cache-read: it is an order of magnitude larger and would flatten every message to the same size. */
export type TokenMetric = "work" | "output" | "total";

export interface Mark {
  uuid: string;
  kind: MarkKind;
  /** 1-based turn number, or null for events outside any turn (leading meta lines). */
  turnSeq: number | null;
  t: number;
  durationMs: number;
  /** The chosen metric's value; 0 when the event has no usage row. */
  value: number;
  /** Prompt size for this request — how full the context window was at this message. 0 when the
   *  event has no usage row. Independent of the metric toggle: it answers a different question. */
  context: number;
  /** Audit annotations for the rail below the baseline. */
  error: boolean;
  finding: Severity | null;
  fileChange: boolean;
  /** How many file changes this message made — the rail shows one square either way. */
  fileChangeCount: number;
  spawn: boolean;
}

/**
 * Classify an event. Order matters: a failed tool call outranks a successful one, and any tool call
 * outranks the prose around it, because the tool is what the reader is scanning for.
 */
export function markKind(e: EventNode): MarkKind {
  if (e.toolCalls.some((t) => t.status === "error")) return "tool-error";
  if (e.toolCalls.length) return "tool";
  if (e.thinking && !e.text) return "thinking";
  if (e.role === "user") return "user";
  if (e.role === "assistant") return "assistant";
  return "meta";
}

export function metricValue(e: EventNode, metric: TokenMetric): number {
  if (!e.usage) return 0;
  if (metric === "output") return e.usage.output;
  if (metric === "total") return workTokens(e.usage) + e.usage.cache_read;
  return workTokens(e.usage);
}

/**
 * How much of the context window this request occupied: the whole prompt the model was sent, which is
 * input + cache-write + cache-read on the usage row. Output is deliberately absent — it is what came
 * back, not what was carried in.
 *
 * Purely descriptive, and it must stay that way — the line has no threshold, no warning colour and no
 * "start a fresh session" prompt, and that is a decision rather than an omission.
 *
 * The obvious gauge would flag a filling context as a problem. The only measure available for testing
 * that was work tokens per line of churn, which is disqualified on its own terms (it scores a surgical
 * fix as the worst outcome), and even under it the relationship was U-shaped rather than monotonic —
 * so the warning would have been backwards over most of its range even by its own broken yardstick.
 * Two independent reasons not to ship it; neither licenses the inverse claim either.
 */
export function contextTokens(e: EventNode): number {
  return e.usage ? e.usage.input + e.usage.cache_creation + e.usage.cache_read : 0;
}

/** Most-severe-first, so an event carrying several findings shows its worst one. */
const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export interface BuildMarksInput {
  events: readonly EventNode[];
  points: readonly TimelinePoint[];
  findings?: readonly Finding[] | null;
  fileChanges?: readonly FileChangeRow[] | null;
  /** turn id -> its 0-based `seq`, for the hover label. */
  turnSeqById?: ReadonlyMap<string, number> | null;
  metric: TokenMetric;
}

/**
 * Join placed points back to their events and annotations. Driven by `points` rather than `events`, so
 * ordering and the null-timestamp exclusion stay the scale's business alone.
 */
export function buildMarks({ events, points, findings, fileChanges, turnSeqById, metric }: BuildMarksInput): Mark[] {
  const byUuid = new Map(events.map((e) => [e.uuid, e]));

  const worstFinding = new Map<string, Severity>();
  for (const f of findings ?? []) {
    if (!f.event_uuid) continue;
    const prev = worstFinding.get(f.event_uuid);
    if (!prev || SEVERITY_ORDER.indexOf(f.severity) < SEVERITY_ORDER.indexOf(prev)) {
      worstFinding.set(f.event_uuid, f.severity);
    }
  }

  const changed = new Map<string, number>();
  for (const c of fileChanges ?? []) if (c.event_uuid) changed.set(c.event_uuid, (changed.get(c.event_uuid) ?? 0) + 1);

  const marks: Mark[] = [];
  for (const p of points) {
    const e = byUuid.get(p.uuid);
    if (!e) continue;
    const turnSeq = e.turn_id != null ? turnSeqById?.get(e.turn_id) : undefined;
    marks.push({
      uuid: p.uuid,
      kind: markKind(e),
      turnSeq: turnSeq == null ? null : turnSeq + 1,
      t: p.t,
      durationMs: p.durationMs,
      value: metricValue(e, metric),
      context: contextTokens(e),
      error: e.toolCalls.some((t) => t.status === "error"),
      finding: worstFinding.get(p.uuid) ?? null,
      fileChange: (changed.get(p.uuid) ?? 0) > 0,
      fileChangeCount: changed.get(p.uuid) ?? 0,
      spawn: e.toolCalls.some((t) => t.spawned_session_id),
    });
  }
  return marks;
}

/** True when no event carries a usage row — the band then falls back to uniform heights and hides the
 *  metric toggle, which is the case a newer SPA hits against a server that predates per-event usage. */
export function hasUsage(events: readonly EventNode[]): boolean {
  return events.some((e) => e.usage);
}
