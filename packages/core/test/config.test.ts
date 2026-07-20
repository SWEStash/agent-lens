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
