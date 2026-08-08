/**
 * The in-transcript search model (transcript/search.ts). It decides what the counter says, which turn
 * headers get a badge, and where ◂/▸ land — so the properties pinned here are: substring (not token)
 * matching, case-insensitivity, the short-query guard, and that tool payloads are searched, since
 * that's where the paths and secrets an audit is looking for actually live.
 * Imports SOURCE (web has no per-module dist).
 */
import { describe, it, expect } from "vitest";
import type { EventNode } from "../src/api";
import { buildHaystacks, fieldMatches, searchSession } from "../src/transcript/search";

function ev(uuid: string, turnId: string | null, fields: Partial<EventNode> = {}): EventNode {
  return {
    uuid,
    type: "assistant",
    role: "assistant",
    timestamp: null,
    model: null,
    is_sidechain: 0,
    turn_id: turnId,
    text: null,
    thinking: null,
    toolCalls: [],
    ...fields,
  } as EventNode;
}

function run(events: EventNode[], q: string) {
  return searchSession(events, buildHaystacks(events), q);
}

describe("searchSession", () => {
  it("matches a substring mid-word and is case-insensitive", () => {
    const events = [ev("a", "t1", { text: "export AWS_SECRET=hunter2" })];
    expect(run(events, "aws_secret").total).toBe(1);
    expect(run(events, "AWS_Secret").total).toBe(1);
    // Mid-word: an FTS tokenizer would need the whole token; in-page find must not.
    expect(run(events, "S_SEC").total).toBe(1);
  });

  it("counts every occurrence in a message but navigates per message", () => {
    const events = [ev("a", "t1", { text: "foo foo foo" }), ev("b", "t1", { text: "foo" })];
    const m = run(events, "foo");
    expect(m.total).toBe(2); // two navigable messages
    expect(m.hits.map((h) => h.count)).toEqual([3, 1]);
  });

  it("keeps hits in transcript order", () => {
    const events = [ev("a", "t1", { text: "match" }), ev("b", "t1", { text: "no" }), ev("c", "t2", { text: "match" })];
    expect(run(events, "match").hits.map((h) => h.uuid)).toEqual(["a", "c"]);
  });

  it("aggregates matching messages per turn for the collapsed header badge", () => {
    const events = [
      ev("a", "t1", { text: "match" }),
      ev("b", "t1", { text: "match" }),
      ev("c", "t2", { text: "match" }),
      ev("d", null, { text: "match" }), // un-turned events still count toward the total
    ];
    const m = run(events, "match");
    expect(m.total).toBe(4);
    expect([...m.byTurn]).toEqual([
      ["t1", 2],
      ["t2", 1],
    ]);
  });

  it("searches thinking blocks and tool inputs, results and spilled full results", () => {
    const hidden = (fields: Partial<EventNode>) => run([ev("a", "t1", fields)], "needle").total;
    expect(hidden({ thinking: "the needle is here" })).toBe(1);
    expect(hidden({ toolCalls: [{ tool_name: "Bash", input_json: '{"command":"needle"}' } as any] })).toBe(1);
    expect(hidden({ toolCalls: [{ tool_name: "Bash", result_summary: "found needle" } as any] })).toBe(1);
    expect(hidden({ toolCalls: [{ tool_name: "Bash", full_result: { text: "needle", bytes: 6 } } as any] })).toBe(1);
  });

  it("returns nothing for a blank or one-character query", () => {
    const events = [ev("a", "t1", { text: "a rather ordinary message" })];
    expect(run(events, "").total).toBe(0);
    expect(run(events, "   ").total).toBe(0);
    expect(run(events, "a").total).toBe(0);
    expect(run(events, " a ").total).toBe(0);
    expect(run(events, "or").total).toBe(1); // two characters is enough
  });

  it("ignores surrounding whitespace in the query", () => {
    expect(run([ev("a", "t1", { text: "ordinary" })], "  ordin  ").total).toBe(1);
  });

  it("returns an empty model when nothing matches", () => {
    const m = run([ev("a", "t1", { text: "nothing here" })], "absent");
    expect(m.total).toBe(0);
    expect(m.hits).toEqual([]);
    expect(m.byTurn.size).toBe(0);
  });
});

describe("fieldMatches", () => {
  it("reports only on the field it is given, case-insensitively", () => {
    expect(fieldMatches("The Needle", "needle")).toBe(true);
    expect(fieldMatches("haystack", "needle")).toBe(false);
  });

  it("is false for absent text or a query under the minimum", () => {
    expect(fieldMatches(null, "needle")).toBe(false);
    expect(fieldMatches(undefined, "needle")).toBe(false);
    expect(fieldMatches("anything", "a")).toBe(false);
    expect(fieldMatches("anything", "")).toBe(false);
  });
});
