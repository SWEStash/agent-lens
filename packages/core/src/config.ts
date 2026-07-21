/**
 * Runtime configuration resolver — server settings (port/host) and the store path (db) layered over
 * the SAME agent-lens.config.json that carries `sources`/`exclude`. Kept here (not in sources.ts) so
 * the file is parsed in one place and both the source resolver and the runtime knobs share it.
 *
 * Precedence, highest wins:  CLI flag (override arg)  >  env var  >  config file  >  built-in default.
 *
 * Deliberately NOT resolved here:
 *  - The non-loopback bind guard (`AGENT_LENS_ALLOW_NONLOCAL`) — a privacy guardrail (ADR-005) that
 *    stays an explicit env-only override enforced by the server, never a convenient flag/config key.
 *  - The data dir (`AGENT_LENS_DATA`) — it is where the config file is *found* (see resolveConfigFile),
 *    so reading it back out of that file would be circular. Env-only by construction.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expandPath, findRepoRoot, resolveConfigFile, resolveDataDir } from "./paths.js";

/** Shape of agent-lens.config.json (only the fields this module and sources.ts read). */
export interface AgentLensConfigFile {
  sources?: unknown[];
  exclude?: unknown[];
  /** SQLite store path. Top-level, not under `server`: ingest and export read it too. */
  db?: string;
  server?: { port?: number; host?: string };
}

export const DEFAULT_PORT = 4477;
export const DEFAULT_HOST = "127.0.0.1"; // loopback only
export const DEFAULT_DB_NAME = "agent-lens.db";

/**
 * Read + parse the resolved config file once, or null when none exists. Shared by `sources.ts`
 * (sources/exclude) and this module (server settings) so the JSON is read a single time per call.
 */
export function readConfigFile(): AgentLensConfigFile | null {
  const repoRoot = findRepoRoot();
  const dataDir = resolveDataDir(repoRoot);
  const file = resolveConfigFile(repoRoot, dataDir);
  return file ? (JSON.parse(readFileSync(file, "utf8")) as AgentLensConfigFile) : null;
}

/** Where a resolved value came from — surfaced by `agent-lens config` for support/discoverability. */
export type ConfigOrigin = "flag" | "env" | "file" | "default";

export interface ResolvedDb {
  path: string;
  origin: ConfigOrigin;
}

/**
 * Resolve the SQLite store path with the same precedence as the server settings:
 * `--db` flag > AGENT_LENS_DB > config `db` > `<dataDir>/agent-lens.db`.
 *
 * The flag and env layers keep the pre-existing semantics EXACTLY — the raw string, any non-empty
 * value wins — so upgrading can never repoint the store of an install that already sets them. In
 * particular a literal `~`/`$HOME` in AGENT_LENS_DB keeps resolving the way it always did (as a
 * directory of that name); expanding it here would silently move such an install to a different,
 * empty database. Only the `db` config key — which no existing install can have — gets expandPath,
 * matching how `sources[].configDir` has always been treated.
 *
 * The triage store is derived from this path's directory by the server (ADR-018), so pointing `db`
 * elsewhere moves the pair together.
 */
export function resolveDbPath(override?: string, cfg: AgentLensConfigFile | null = readConfigFile()): ResolvedDb {
  if (override) return { path: override, origin: "flag" };
  if (process.env.AGENT_LENS_DB) return { path: process.env.AGENT_LENS_DB, origin: "env" };
  if (isSet(cfg?.db)) return { path: expandPath(String(cfg!.db).trim()), origin: "file" };
  return { path: join(resolveDataDir(findRepoRoot()), DEFAULT_DB_NAME), origin: "default" };
}

export interface ServerOverrides {
  /** From a CLI flag (`serve --port/--host`); highest precedence. Empty/undefined means "not set". */
  port?: number | string;
  host?: string;
}

export interface ResolvedServer {
  port: number;
  host: string;
  portOrigin: ConfigOrigin;
  hostOrigin: ConfigOrigin;
}

/** Validate a port from any source into an integer 1-65535, or throw a clear, source-tagged error. */
export function validatePort(value: number | string, source: string): number {
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`agent-lens: invalid port from ${source}: '${value}' (expected an integer 1-65535)`);
  }
  return n;
}

function isSet(v: unknown): boolean {
  return v !== undefined && v !== null && String(v).trim() !== "";
}

/**
 * Resolve the effective server port + host with precedence flag > env > file > default. Validates the
 * port (range) and host (non-empty) at every layer so a bad value fails fast at startup rather than
 * silently coercing to NaN. Does NOT enforce the loopback guard — the server still does that.
 */
export function resolveServerConfig(
  overrides: ServerOverrides = {},
  cfg: AgentLensConfigFile | null = readConfigFile(),
): ResolvedServer {
  let port: number;
  let portOrigin: ConfigOrigin;
  if (isSet(overrides.port)) {
    port = validatePort(overrides.port as number | string, "--port");
    portOrigin = "flag";
  } else if (isSet(process.env.AGENT_LENS_PORT)) {
    port = validatePort(process.env.AGENT_LENS_PORT!, "AGENT_LENS_PORT");
    portOrigin = "env";
  } else if (isSet(cfg?.server?.port)) {
    port = validatePort(cfg!.server!.port!, "server.port (config file)");
    portOrigin = "file";
  } else {
    port = DEFAULT_PORT;
    portOrigin = "default";
  }

  let host: string;
  let hostOrigin: ConfigOrigin;
  if (isSet(overrides.host)) {
    host = String(overrides.host).trim();
    hostOrigin = "flag";
  } else if (isSet(process.env.AGENT_LENS_HOST)) {
    host = process.env.AGENT_LENS_HOST!.trim();
    hostOrigin = "env";
  } else if (isSet(cfg?.server?.host)) {
    host = String(cfg!.server!.host).trim();
    hostOrigin = "file";
  } else {
    host = DEFAULT_HOST;
    hostOrigin = "default";
  }

  return { port, host, portOrigin, hostOrigin };
}
