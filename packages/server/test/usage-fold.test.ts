/**
 * Per-event token usage is attributed to the event a reader can SEE.
 *
 * Claude Code writes one transcript line per content block of an assistant response, each repeating
 * the same `usage` and `message.id`; ingest collapses those to a single `token_usage` row (the unique
 * `(session_id, message_id)` index), and the row that survives keeps the FIRST line's `event_uuid`.
 * That first block is almost always a `thinking` block whose text arrives stripped, so the anchor
 * event renders nothing at all.
 *
 * Measured on a 1 GB corpus: 52% of usage rows sit on events with no renderable body, and those rows
 * carry 75% of all work tokens. Attributing strictly per row would put three quarters of a session's
 * spend on messages that draw nothing — so the transcript's token chip and the timeline band's bar
 * heights would each describe a quarter of reality.
 */
import { describe, it, expect } from "vitest";
import type { SessionDetail } from "@agent-lens/contracts";
import { addEvent, addSession, addTokens, addTool, addTurn, appFor, freshDb } from "./helpers/seed";

const SPLIT = { input: 10, output: 20, cache_creation: 30, cache_read: 40 };
const seedTokens = { input: 10, output: 20, cacheCreate: 30, cacheRead: 40 };

async function detailOf(db: ReturnType<typeof freshDb>): Promise<SessionDetail> {
  const app = await appFor(db);
  const body = (await app.inject({ method: "GET", url: "/api/sessions/s1" })).json();
  await app.close();
  return body as SessionDetail;
}

/** A session with one turn; callers add the events. */
function base() {
  const db = freshDb();
  addSession(db, "s1", { startedAt: "2026-01-01T00:00:00Z" });
  const turn = addTurn(db, "s1", 0, { startedAt: "2026-01-01T00:00:00Z" });
  return { db, turn };
}

const usageOf = (d: SessionDetail, uuid: string) => d.events.find((e) => e.uuid === uuid)?.usage;

describe("token usage attribution", () => {
  it("folds an empty event's usage onto the next event that renders", async () => {
    const { db, turn } = base();
    // e1 is the stripped thinking block that carries the usage row; e2 is the visible reply.
    addEvent(db, "s1", "e1", { turn, seq: 0, role: "assistant", timestamp: "2026-01-01T00:00:00Z" });
    addTokens(db, "e1", "s1", "m", { ...seedTokens, turn });
    addEvent(db, "s1", "e2", { turn, seq: 1, role: "assistant", text: "the reply", timestamp: "2026-01-01T00:00:01Z" });

    const d = await detailOf(db);
    expect(usageOf(d, "e1")).toBeUndefined();
    expect(usageOf(d, "e2")).toEqual(SPLIT);
  });

  it("accumulates a run of empty events onto the one visible message", async () => {
    const { db, turn } = base();
    for (const [i, uuid] of ["e1", "e2", "e3"].entries()) {
      addEvent(db, "s1", uuid, { turn, seq: i, role: "assistant", timestamp: `2026-01-01T00:00:0${i}Z` });
      addTokens(db, uuid, "s1", "m", { ...seedTokens, turn });
    }
    addEvent(db, "s1", "e4", { turn, seq: 3, role: "assistant", text: "visible", timestamp: "2026-01-01T00:00:03Z" });

    const d = await detailOf(db);
    expect(usageOf(d, "e4")).toEqual({ input: 30, output: 60, cache_creation: 90, cache_read: 120 });
  });

  it("adds folded usage to the rendering event's own, rather than replacing it", async () => {
    const { db, turn } = base();
    addEvent(db, "s1", "e1", { turn, seq: 0, role: "assistant", timestamp: "2026-01-01T00:00:00Z" });
    addTokens(db, "e1", "s1", "m", { ...seedTokens, turn });
    addEvent(db, "s1", "e2", { turn, seq: 1, role: "assistant", text: "visible", timestamp: "2026-01-01T00:00:01Z" });
    addTokens(db, "e2", "s1", "m", { input: 1, output: 2, cacheCreate: 3, cacheRead: 4, turn });

    const d = await detailOf(db);
    expect(usageOf(d, "e2")).toEqual({ input: 11, output: 22, cache_creation: 33, cache_read: 44 });
  });

  it("folds trailing usage BACK onto the last rendering event rather than dropping it", async () => {
    const { db, turn } = base();
    addEvent(db, "s1", "e1", { turn, seq: 0, role: "assistant", text: "visible", timestamp: "2026-01-01T00:00:00Z" });
    addEvent(db, "s1", "e2", { turn, seq: 1, role: "assistant", timestamp: "2026-01-01T00:00:01Z" });
    addTokens(db, "e2", "s1", "m", { ...seedTokens, turn });

    const d = await detailOf(db);
    expect(usageOf(d, "e1")).toEqual(SPLIT);
  });

  it("counts a tool call as rendering, so a tool-only event keeps its own usage", async () => {
    const { db, turn } = base();
    addEvent(db, "s1", "e1", { turn, seq: 0, role: "assistant", timestamp: "2026-01-01T00:00:00Z" });
    addTool(db, "s1", "e1", "tc1", "Bash", { turn });
    addTokens(db, "e1", "s1", "m", { ...seedTokens, turn });

    const d = await detailOf(db);
    expect(usageOf(d, "e1")).toEqual(SPLIT);
  });

  it("never moves usage across a turn boundary", async () => {
    const { db, turn } = base();
    const turn2 = addTurn(db, "s1", 1, { startedAt: "2026-01-01T00:01:00Z" });
    // The only rendering event is in the NEXT turn: the usage must not migrate to it.
    addEvent(db, "s1", "e1", { turn, seq: 0, role: "assistant", timestamp: "2026-01-01T00:00:00Z" });
    addTokens(db, "e1", "s1", "m", { ...seedTokens, turn });
    addEvent(db, "s1", "e2", { turn: turn2, seq: 1, role: "assistant", text: "next turn", timestamp: "2026-01-01T00:01:00Z" });

    const d = await detailOf(db);
    expect(usageOf(d, "e2")).toBeUndefined();
  });

  it("conserves the session total — folding moves tokens, it never invents or loses them", async () => {
    const { db, turn } = base();
    addEvent(db, "s1", "e1", { turn, seq: 0, role: "assistant", timestamp: "2026-01-01T00:00:00Z" });
    addTokens(db, "e1", "s1", "m", { ...seedTokens, turn });
    addEvent(db, "s1", "e2", { turn, seq: 1, role: "assistant", text: "visible", timestamp: "2026-01-01T00:00:01Z" });
    addTokens(db, "e2", "s1", "m", { ...seedTokens, turn });

    const d = await detailOf(db);
    const onWire = d.events.reduce(
      (sum, e) => sum + (e.usage ? e.usage.input + e.usage.output + e.usage.cache_creation + e.usage.cache_read : 0),
      0,
    );
    // The header total aggregates token_usage directly and does not go through the fold, so the two
    // agreeing is what proves the fold is a redistribution rather than a rewrite.
    expect(onWire).toBe(d.session.tokens);
  });
});
