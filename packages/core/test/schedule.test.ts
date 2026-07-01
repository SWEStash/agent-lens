/**
 * Scheduler generators (schedule.ts) — the pure unit/plist/OnCalendar text that gets written for
 * systemd / launchd. The OS-command side (systemctl/launchctl/schtasks) isn't exercised here; it's
 * validated out-of-band (systemd-analyze verify) since it mutates real user state.
 * Imports the BUILT dist so it exercises exactly what ships.
 */
import { describe, it, expect } from "vitest";
import { parseHours, onCalendarHours, systemdService, systemdTimer, launchdPlist, DEFAULT_HOURS } from "../dist/index.js";

const NODE = "/usr/bin/node";
const CLI = "/opt/agent-lens/dist/agent-lens.js";

describe("parseHours", () => {
  it("defaults to 9,13,17,21", () => expect(parseHours(undefined)).toEqual(DEFAULT_HOURS));
  it("parses, dedups, and sorts", () => expect(parseHours("21, 9, 9, 13")).toEqual([9, 13, 21]));
  it("rejects out-of-range / non-numeric", () => {
    expect(() => parseHours("99")).toThrow(/invalid hours/);
    expect(() => parseHours("nope")).toThrow(/invalid hours/);
  });
});

describe("onCalendarHours", () => {
  it("zero-pads and joins with :00", () => {
    expect(onCalendarHours([9, 13, 17, 21])).toBe("09,13,17,21:00");
    expect(onCalendarHours([0, 6])).toBe("00,06:00");
  });
});

describe("systemd units", () => {
  it("service runs `collect --then-ingest` with absolute node + CLI", () => {
    const s = systemdService(NODE, CLI);
    expect(s).toContain(`ExecStart=${NODE} ${CLI} collect --then-ingest`);
    expect(s).toContain("Type=oneshot");
  });
  it("timer sets OnCalendar from the hours and installs to timers.target", () => {
    const t = systemdTimer([9, 21]);
    expect(t).toContain("OnCalendar=*-*-* 09,21:00");
    expect(t).toContain("Persistent=true");
    expect(t).toContain("WantedBy=timers.target");
  });
});

describe("launchd plist", () => {
  it("bakes the program args and one calendar entry per hour", () => {
    const p = launchdPlist(NODE, CLI, [9, 17], "/data/schedule.log");
    expect(p).toContain("<string>org.agent-lens.collect</string>");
    expect(p).toContain(`<string>${NODE}</string>`);
    expect(p).toContain(`<string>${CLI}</string>`);
    expect(p).toContain("<string>--then-ingest</string>");
    expect(p).toContain("<key>Hour</key><integer>9</integer>");
    expect(p).toContain("<key>Hour</key><integer>17</integer>");
    expect(p).toContain("<string>/data/schedule.log</string>");
  });
});
