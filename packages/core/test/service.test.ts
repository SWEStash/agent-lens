/**
 * Service generators (service.ts) — the pure unit/plist/OnCalendar text that gets written for
 * systemd / launchd. The OS-command side (systemctl/launchctl/schtasks) isn't exercised here; it's
 * validated out-of-band (systemd-analyze verify) since it mutates real user state.
 * Imports the BUILT dist so it exercises exactly what ships.
 */
import { describe, it, expect } from "vitest";
import {
  parseHours,
  parseTargets,
  onCalendarHours,
  systemdCollectorService,
  systemdCollectorTimer,
  systemdServerService,
  launchdCollectorPlist,
  launchdServerPlist,
  DEFAULT_HOURS,
} from "../dist/index.js";

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

describe("parseTargets", () => {
  it("defaults to both", () => expect(parseTargets(undefined)).toEqual(["collector", "server"]));
  it("treats 'all' as both", () => expect(parseTargets("all")).toEqual(["collector", "server"]));
  it("selects a single target", () => {
    expect(parseTargets("collector")).toEqual(["collector"]);
    expect(parseTargets("server")).toEqual(["server"]);
  });
  it("rejects unknown targets", () => expect(() => parseTargets("web")).toThrow(/invalid target/));
});

describe("onCalendarHours", () => {
  it("zero-pads and joins with :00", () => {
    expect(onCalendarHours([9, 13, 17, 21])).toBe("09,13,17,21:00");
    expect(onCalendarHours([0, 6])).toBe("00,06:00");
  });
});

describe("systemd collector units", () => {
  it("service runs `collect --then-ingest` with absolute node + CLI", () => {
    const s = systemdCollectorService(NODE, CLI);
    expect(s).toContain(`ExecStart=${NODE} ${CLI} collect --then-ingest`);
    expect(s).toContain("Type=oneshot");
  });
  it("timer sets OnCalendar from the hours and installs to timers.target", () => {
    const t = systemdCollectorTimer([9, 21]);
    expect(t).toContain("OnCalendar=*-*-* 09,21:00");
    expect(t).toContain("Persistent=true");
    expect(t).toContain("WantedBy=timers.target");
  });
});

describe("systemd server unit", () => {
  it("runs `serve` as a restarting long-running service", () => {
    const s = systemdServerService(NODE, CLI);
    expect(s).toContain(`ExecStart=${NODE} ${CLI} serve`);
    expect(s).toContain("Type=simple");
    expect(s).toContain("Restart=on-failure");
    expect(s).toContain("WantedBy=default.target");
  });
  it("bakes AGENT_LENS_PORT / AGENT_LENS_HOST when provided", () => {
    const s = systemdServerService(NODE, CLI, { AGENT_LENS_PORT: "5000", AGENT_LENS_HOST: "127.0.0.1" });
    expect(s).toContain("Environment=AGENT_LENS_PORT=5000");
    expect(s).toContain("Environment=AGENT_LENS_HOST=127.0.0.1");
  });
});

describe("launchd collector plist", () => {
  it("bakes the program args and one calendar entry per hour", () => {
    const p = launchdCollectorPlist(NODE, CLI, [9, 17], "/data/schedule.log");
    expect(p).toContain("<string>org.agent-lens.collect</string>");
    expect(p).toContain(`<string>${NODE}</string>`);
    expect(p).toContain(`<string>${CLI}</string>`);
    expect(p).toContain("<string>--then-ingest</string>");
    expect(p).toContain("<key>Hour</key><integer>9</integer>");
    expect(p).toContain("<key>Hour</key><integer>17</integer>");
    expect(p).toContain("<string>/data/schedule.log</string>");
  });
});

describe("launchd server plist", () => {
  it("runs `serve`, kept alive and started at load", () => {
    const p = launchdServerPlist(NODE, CLI, "/data/server.log");
    expect(p).toContain("<string>org.agent-lens.server</string>");
    expect(p).toContain("<string>serve</string>");
    expect(p).toContain("<key>KeepAlive</key><true/>");
    expect(p).toContain("<key>RunAtLoad</key><true/>");
    expect(p).toContain("<string>/data/server.log</string>");
  });
  it("bakes env vars when provided", () => {
    const p = launchdServerPlist(NODE, CLI, "/data/server.log", { AGENT_LENS_PORT: "5000" });
    expect(p).toContain("<key>EnvironmentVariables</key>");
    expect(p).toContain("<key>AGENT_LENS_PORT</key><string>5000</string>");
  });
});
