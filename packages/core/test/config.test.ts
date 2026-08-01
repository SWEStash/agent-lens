/**
 * Runtime config resolver (config.ts) — pins the precedence contract flag > env > file > default for
 * the server port/host, and the fail-fast port validation. Imports the BUILT dist so it exercises
 * exactly what ships. `resolveServerConfig` takes the parsed config as an arg, so these tests control
 * the "file" layer directly and the env layer via process.env (saved/restored per test).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveDbPath,
  resolvePricing,
  resolveServerConfig,
  validatePort,
  DEFAULT_DB_NAME,
  DEFAULT_PORT,
  DEFAULT_HOST,
} from "../dist/index.js";

const PORT = "AGENT_LENS_PORT";
const HOST = "AGENT_LENS_HOST";
const DB = "AGENT_LENS_DB";
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = { [PORT]: process.env[PORT], [HOST]: process.env[HOST], [DB]: process.env[DB] };
  delete process.env[PORT];
  delete process.env[HOST];
  delete process.env[DB];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("resolveServerConfig precedence", () => {
  it("falls back to built-in defaults when nothing is set", () => {
    const r = resolveServerConfig({}, null);
    expect(r).toMatchObject({ port: DEFAULT_PORT, host: DEFAULT_HOST, portOrigin: "default", hostOrigin: "default" });
  });

  it("reads the config file when neither flag nor env is set", () => {
    const r = resolveServerConfig({}, { server: { port: 5601, host: "localhost" } });
    expect(r).toMatchObject({ port: 5601, host: "localhost", portOrigin: "file", hostOrigin: "file" });
  });

  it("env beats the config file", () => {
    process.env[PORT] = "5602";
    process.env[HOST] = "127.0.0.1";
    const r = resolveServerConfig({}, { server: { port: 5601, host: "localhost" } });
    expect(r).toMatchObject({ port: 5602, portOrigin: "env", hostOrigin: "env" });
  });

  it("a flag beats env and file", () => {
    process.env[PORT] = "5602";
    const r = resolveServerConfig({ port: "5603" }, { server: { port: 5601 } });
    expect(r).toMatchObject({ port: 5603, portOrigin: "flag" });
  });

  it("resolves port and host independently", () => {
    process.env[PORT] = "5610"; // env port, file host
    const r = resolveServerConfig({}, { server: { host: "localhost" } });
    expect(r).toMatchObject({ port: 5610, portOrigin: "env", host: "localhost", hostOrigin: "file" });
  });

  it("treats empty-string overrides as unset (does not override lower layers)", () => {
    const r = resolveServerConfig({ port: "", host: "" }, { server: { port: 5601 } });
    expect(r).toMatchObject({ port: 5601, portOrigin: "file", host: DEFAULT_HOST, hostOrigin: "default" });
  });
});

describe("resolveDbPath precedence", () => {
  it("falls back to <dataDir>/agent-lens.db when nothing is set", () => {
    const r = resolveDbPath(undefined, null);
    expect(r.origin).toBe("default");
    expect(r.path.endsWith(DEFAULT_DB_NAME)).toBe(true);
  });

  it("reads the config file when neither flag nor env is set", () => {
    const r = resolveDbPath(undefined, { db: "/srv/lens/store.db" });
    expect(r).toMatchObject({ path: "/srv/lens/store.db", origin: "file" });
  });

  it("env beats the config file", () => {
    process.env[DB] = "/srv/lens/from-env.db";
    const r = resolveDbPath(undefined, { db: "/srv/lens/store.db" });
    expect(r).toMatchObject({ path: "/srv/lens/from-env.db", origin: "env" });
  });

  it("a flag beats env and file", () => {
    process.env[DB] = "/srv/lens/from-env.db";
    const r = resolveDbPath("/srv/lens/from-flag.db", { db: "/srv/lens/store.db" });
    expect(r).toMatchObject({ path: "/srv/lens/from-flag.db", origin: "flag" });
  });

  it("treats an empty-string flag as unset (does not override lower layers)", () => {
    const r = resolveDbPath("", { db: "/srv/lens/store.db" });
    expect(r).toMatchObject({ path: "/srv/lens/store.db", origin: "file" });
  });

  it("expands ~ in a config-file path, like sources[].configDir", () => {
    const r = resolveDbPath(undefined, { db: "~/lens/store.db" });
    expect(r).toMatchObject({ path: join(homedir(), "lens/store.db"), origin: "file" });
  });

  // Back-compat: the flag/env layers must stay byte-identical to the pre-change `a || b || default`
  // expression, or upgrading would repoint an install that already sets them at a different file.
  it("passes flag and env values through verbatim — no expansion, no trimming", () => {
    const flag = resolveDbPath("~/legacy.db", null);
    expect(flag).toMatchObject({ path: "~/legacy.db", origin: "flag" });

    process.env[DB] = "$HOME/legacy.db";
    expect(resolveDbPath(undefined, null)).toMatchObject({ path: "$HOME/legacy.db", origin: "env" });

    process.env[DB] = "  "; // whitespace was a real (if odd) path before; it must still win
    expect(resolveDbPath(undefined, null)).toMatchObject({ path: "  ", origin: "env" });

    process.env[DB] = "relative/store.db"; // resolved against cwd by the driver, exactly as before
    expect(resolveDbPath(undefined, null)).toMatchObject({ path: "relative/store.db", origin: "env" });
  });

  it("resolves the db independently of the server settings", () => {
    process.env[DB] = "/srv/lens/from-env.db";
    const cfg = { db: "/srv/lens/store.db", server: { port: 5601 } };
    expect(resolveDbPath(undefined, cfg).origin).toBe("env");
    expect(resolveServerConfig({}, cfg)).toMatchObject({ port: 5601, portOrigin: "file" });
  });
});

describe("port validation (fail fast)", () => {
  it("rejects an out-of-range flag port", () => {
    expect(() => resolveServerConfig({ port: "99999" })).toThrow(/invalid port from --port/);
  });

  it("rejects a non-numeric env port", () => {
    process.env[PORT] = "abc";
    expect(() => resolveServerConfig({})).toThrow(/AGENT_LENS_PORT/);
  });

  it("rejects a bad port from the config file", () => {
    expect(() => resolveServerConfig({}, { server: { port: 0 } })).toThrow(/config file/);
  });

  it("validatePort accepts the boundaries and rejects beyond them", () => {
    expect(validatePort(1, "t")).toBe(1);
    expect(validatePort(65535, "t")).toBe(65535);
    expect(() => validatePort(0, "t")).toThrow();
    expect(() => validatePort(65536, "t")).toThrow();
    expect(() => validatePort(1.5, "t")).toThrow();
  });
});

/** Prices have no flag or env layer (see resolvePricing) — "file" and "default" are the only origins,
 *  and unlike the port, a bad value degrades the estimate instead of failing startup. */
describe("resolvePricing", () => {
  it("no config file, or no pricing block → the built-in table, origin 'default'", () => {
    for (const cfg of [null, {}, { db: "/tmp/x.db" }]) {
      const p = resolvePricing(cfg);
      expect(p.origin).toBe("default");
      expect(p.applied).toEqual([]);
      expect(p.table["claude-opus-5"].input).toBe(5);
    }
  });

  it("a valid override flips the origin to 'file' and lands in the table", () => {
    const p = resolvePricing({ pricing: { "claude-opus-5": { input: 4, output: 20 } } });
    expect(p.origin).toBe("file");
    expect(p.applied).toEqual(["claude-opus-5"]);
    expect(p.table["claude-opus-5"]).toEqual({ input: 4, output: 20, cacheWrite: 5, cacheRead: 0.4 });
  });

  it("a malformed override is reported, dropped, and does NOT count as a file-origin override", () => {
    const p = resolvePricing({ pricing: { "claude-opus-5": { output: 25 } } });
    expect(p.invalid).toEqual(["claude-opus-5"]);
    expect(p.applied).toEqual([]);
    expect(p.origin).toBe("default"); // nothing took effect, so don't claim the file layer is in force
    expect(p.table["claude-opus-5"].input).toBe(5);
  });
});
