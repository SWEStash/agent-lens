/**
 * Canonical source resolver for Agent Lens (shared by the collector, ingester, server, CLI, and
 * the dev-only scripts/sources.mjs shim).
 *
 * A "source" is a labeled agent instance: { label, agent, configDir }. Multiple local accounts
 * (each with its own config folder) are each a source — e.g. "personal" → ~/.claude.
 *
 * Resolution order (see resolveConfigFile in paths.ts):
 *   1. $CLAUDE_DIR set    → single legacy source { label: $AGENT_LENS_LABEL|"default", ~/.claude }
 *   2. $AGENT_LENS_CONFIG → that JSON file
 *   3. <dataDir>/agent-lens.config.json   (installed user's config, next to their data)
 *   4. <repo>/agent-lens.config.json  →  <repo>/agent-lens.config.example.json
 *   5. built-in default  → { label: "default", agent: "claude-code", configDir: "$HOME/.claude" }
 *
 * Excluded projects (playgrounds, personal, dummy tests, …) are resolved here too, from the config's
 * top-level `exclude: [<realProjectPath>, …]` plus the `AGENT_LENS_EXCLUDE` env (comma-separated).
 * They are honored at every stage — collect (not mirrored), ingest (not stored / pruned), corpus.
 */
import { expandPath } from "./paths.js";
import { readConfigFile } from "./config.js";

export interface Source {
  label: string;
  agent: string;
  configDir: string;
}

export function loadSources(): Source[] {
  // 1. legacy single-source override (used by tests and ad-hoc runs)
  if (process.env.CLAUDE_DIR) {
    return [
      {
        label: process.env.AGENT_LENS_LABEL || "default",
        agent: "claude-code",
        configDir: expandPath(process.env.CLAUDE_DIR),
      },
    ];
  }

  const cfg = readConfigFile() ?? { sources: [{ label: "default", agent: "claude-code", configDir: "$HOME/.claude" }] };

  const seen = new Set<string>();
  const out: Source[] = [];
  for (const raw of cfg.sources || []) {
    const s = raw as Partial<Source> | null;
    if (!s || !s.label || !s.configDir) continue;
    if (seen.has(s.label)) throw new Error(`duplicate source label: ${s.label}`);
    seen.add(s.label);
    out.push({ label: s.label, agent: s.agent || "claude-code", configDir: expandPath(s.configDir) });
  }
  if (!out.length) throw new Error("no valid sources configured");
  return out;
}

/**
 * Resolve the list of projects to EXCLUDE everywhere (collect, ingest, corpus). Union of the config's
 * `exclude` array and the `AGENT_LENS_EXCLUDE` env (comma-separated). Returns expanded real paths
 * (no trailing slash). The legacy CLAUDE_DIR mode still honors the env var.
 */
export function loadExcludes(): string[] {
  const fromEnv = (process.env.AGENT_LENS_EXCLUDE || "").split(",");
  let fromCfg: unknown[] = [];
  if (!process.env.CLAUDE_DIR) {
    const cfg = readConfigFile();
    if (cfg && Array.isArray(cfg.exclude)) fromCfg = cfg.exclude;
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...fromCfg, ...fromEnv]) {
    const e = expandPath(String(p ?? "").trim());
    if (e && !seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  }
  return out;
}
