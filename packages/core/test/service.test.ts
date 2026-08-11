/**
 * Service generators (service.ts) — the pure unit/plist/OnCalendar text that gets written for
 * systemd / launchd. The OS-command side (systemctl/launchctl/schtasks) isn't exercised here; it's
 * validated out-of-band (systemd-analyze verify) since it mutates real user state.
 * Imports the BUILT dist so it exercises exactly what ships.
 */
import { userInfo } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  currentUser,
  parseHours,
  parseTargets,
  onCalendarHours,
  systemdCollectorService,
  systemdCollectorTimer,
  systemdServerService,
  launchdCollectorPlist,
  launchdServerPlist,
  DEFAULT_HOURS,
  UserError,
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
  // UserError is what the CLI boundary keys on to print one line instead of a stack trace, so the
  // *type* is load-bearing here, not just the message.
  it("rejects with a UserError, not a bare Error", () => {
    expect(() => parseHours("nope")).toThrow(UserError);
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
  it("rejects with a UserError, not a bare Error", () => expect(() => parseTargets("web")).toThrow(UserError));
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
  /**
   * The collector *writes* the archive, so a unit that resolves a different data dir than the shell
   * that installed it silently mirrors transcripts into the wrong store. Schedulers inherit no
   * environment, so the path vars have to be baked in (ADR-021 makes env the only way to move it).
   */
  it("bakes the path env when given", () => {
    const s = systemdCollectorService(NODE, CLI, {
      AGENT_LENS_DATA: "/srv/lens",
      AGENT_LENS_CONFIG: "/srv/lens.json",
    });
    expect(s).toMatch(/^Environment=AGENT_LENS_DATA=\/srv\/lens$/m);
    expect(s).toMatch(/^Environment=AGENT_LENS_CONFIG=\/srv\/lens\.json$/m);
  });
  it("emits no Environment line when there is nothing to bake", () => {
    expect(systemdCollectorService(NODE, CLI)).not.toMatch(/^Environment=/m);
  });
});

describe("systemd server unit", () => {
  it("runs `serve` as a restarting long-running service", () => {
    const s = systemdServerService(NODE, CLI);
    expect(s).toContain(`ExecStart=${NODE} ${CLI} serve`);
    expect(s).toContain("Type=simple");
    expect(s).toContain("Restart=always");
    expect(s).toContain("WantedBy=default.target");
  });
  // Regression: systemd treats a bare SIGTERM as a *clean* exit, so Restart=on-failure left the
  // server dead whenever a stray `pkill -f 'agent-lens.js serve'` (aimed at an ad-hoc test server)
  // also matched this unit's ExecStart. Restart=always is what makes it come back.
  it("restarts after a clean exit / SIGTERM, not only on failure", () => {
    const s = systemdServerService(NODE, CLI);
    // Anchored: only the directive line counts — the unit's comments mention on-failure by name.
    expect(s).not.toMatch(/^Restart=on-failure$/m);
    expect(s).toMatch(/^Restart=always$/m);
  });
  it("bakes AGENT_LENS_PORT / AGENT_LENS_HOST when provided", () => {
    const s = systemdServerService(NODE, CLI, { AGENT_LENS_PORT: "5000", AGENT_LENS_HOST: "127.0.0.1" });
    expect(s).toContain("Environment=AGENT_LENS_PORT=5000");
    expect(s).toContain("Environment=AGENT_LENS_HOST=127.0.0.1");
  });
  it("carries the path env alongside the server env", () => {
    const s = systemdServerService(NODE, CLI, { AGENT_LENS_DATA: "/srv/lens", AGENT_LENS_PORT: "5000" });
    expect(s).toMatch(/^Environment=AGENT_LENS_DATA=\/srv\/lens$/m);
    expect(s).toMatch(/^Environment=AGENT_LENS_PORT=5000$/m);
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
  it("bakes the path env when given, and omits the dict when not", () => {
    const withEnv = launchdCollectorPlist(NODE, CLI, [9], "/data/schedule.log", { AGENT_LENS_DATA: "/srv/lens" });
    expect(withEnv).toContain("<key>EnvironmentVariables</key>");
    expect(withEnv).toContain("<key>AGENT_LENS_DATA</key><string>/srv/lens</string>");
    expect(launchdCollectorPlist(NODE, CLI, [9], "/data/schedule.log")).not.toContain("EnvironmentVariables");
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

/**
 * `loginctl enable-linger` needs a login name. $USER is set by interactive shells but NOT by
 * systemd/launchd, nor by `env -i` — so reading it from the environment produced an empty argument
 * (and an "enable-linger undefined" hint) exactly in the unattended contexts this command targets.
 */
describe("currentUser", () => {
  let savedUser: string | undefined;
  let savedLogname: string | undefined;
  beforeEach(() => {
    savedUser = process.env.USER;
    savedLogname = process.env.LOGNAME;
  });
  afterEach(() => {
    if (savedUser === undefined) delete process.env.USER;
    else process.env.USER = savedUser;
    if (savedLogname === undefined) delete process.env.LOGNAME;
    else process.env.LOGNAME = savedLogname;
  });

  it("returns the OS login name when $USER and $LOGNAME are unset", () => {
    delete process.env.USER;
    delete process.env.LOGNAME;
    expect(currentUser()).toBe(userInfo().username);
    expect(currentUser()).not.toBe("");
  });

  it("prefers the OS login name over a conflicting $USER (e.g. under sudo)", () => {
    process.env.USER = "someone-else";
    expect(currentUser()).toBe(userInfo().username);
  });
});
