/**
 * matchSkillInjections (pipeline.ts): pairing a session's Skill tool calls with the SKILL.md bodies
 * their firings inject. Pure, so the pairing rules are pinned here without a DB.
 */
import { describe, expect, it } from "vitest";
import { matchSkillInjections, type SkillCall, type SkillEvent } from "../dist/pipeline.js";

const call = (id: string, eventUuid: string, name: string, args?: string): SkillCall => ({
  id,
  event_uuid: eventUuid,
  skill_name: name,
  input_json: JSON.stringify(args === undefined ? { skill: name } : { skill: name, args }),
});
const ev = (uuid: string, ts: string, extra: Partial<SkillEvent> = {}): SkillEvent => ({ uuid, type: "assistant", is_meta: 0, timestamp: ts, text: null, ...extra });
const inject = (uuid: string, ts: string, dir: string, body: string, args?: string): SkillEvent =>
  ev(uuid, ts, { type: "user", is_meta: 1, text: `Base directory for this skill: ${dir}\n\n${body}${args ? `\n\nARGUMENTS: ${args}` : ""}` });

describe("matchSkillInjections", () => {
  it("pairs a call with the injection that follows it, by skill-name token", () => {
    const m = matchSkillInjections("s1", [call("c1", "a1", "plugin:tdd")], [ev("a1", "t1"), inject("i1", "t2", "/skills/tdd", "# TDD\nbody")]);
    expect(m).toEqual([{ callId: "c1", name: "plugin:tdd", baseDir: "/skills/tdd", body: "# TDD\nbody", ts: "t2" }]);
  });

  it("orders events by time, so an injection logged before its call still waits for it", () => {
    // Out of order in the input; sorted by timestamp the call comes first.
    const m = matchSkillInjections("s1", [call("c1", "a1", "tdd")], [inject("i1", "t2", "/s/tdd", "# B"), ev("a1", "t1")]);
    expect(m.map((x) => x.callId)).toEqual(["c1"]);
  });

  it("prefers the pending call whose args match the injection's ARGUMENTS", () => {
    const calls = [call("c1", "a1", "review", "first"), call("c2", "a2", "review", "second")];
    const events = [ev("a1", "t1"), ev("a2", "t2"), inject("i1", "t3", "/s/review", "# R", "second"), inject("i2", "t4", "/s/review", "# R")];
    expect(matchSkillInjections("s1", calls, events).map((x) => x.callId)).toEqual(["c2", "c1"]);
  });

  it("matches nothing for an injection with no pending call, or a call whose body never came", () => {
    expect(matchSkillInjections("s1", [], [inject("i1", "t1", "/s/tdd", "# T")])).toEqual([]);
    expect(matchSkillInjections("s1", [call("c1", "a1", "tdd")], [ev("a1", "t1")])).toEqual([]);
    // A different skill's body does not satisfy the call.
    expect(matchSkillInjections("s1", [call("c1", "a1", "tdd")], [ev("a1", "t1"), inject("i1", "t2", "/s/other", "# O")])).toEqual([]);
  });

  it("ignores user text that is not a meta injection", () => {
    const notMeta = { ...inject("i1", "t2", "/s/tdd", "# T"), is_meta: 0 };
    expect(matchSkillInjections("s1", [call("c1", "a1", "tdd")], [ev("a1", "t1"), notMeta])).toEqual([]);
  });
});
