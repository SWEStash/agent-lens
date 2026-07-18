/**
 * Runtime configuration resolver — server settings (port/host) layered over the SAME
 * agent-lens.config.json that carries `sources`/`exclude`. Kept here (not in sources.ts) so the file
 * is parsed in one place and both the source resolver and the runtime knobs share it.
 *
 * Precedence, highest wins:  CLI flag (override arg)  >  env var  >  config file  >  built-in default.
 *
 * Deliberately NOT resolved here: the non-loopback bind guard (`AGENT_LENS_ALLOW_NONLOCAL`). It is a
 * privacy guardrail (ADR-005) that stays an explicit env-only override enforced by the server, so it
 * is never made a convenient flag/config key.
 */
import { readFileSync } from "node:fs";
import { findRepoRoot, resolveConfigFile, resolveDataDir } from "./paths.js";

/** Shape of agent-lens.config.json (only the fields this module and sources.ts read). */
export interface AgentLensConfigFile {
  sources?: unknown[];
  exclude?: unknown[];
  server?: { port?: number; host?: string };
}

export const DEFAULT_PORT = 4477;
export const DEFAULT_HOST = "127.0.0.1"; // loopback only

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
