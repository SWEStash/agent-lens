#!/usr/bin/env node
/**
 * Canonical source resolver for Agent Lens (shared by collect.sh and the ingester).
 *
 * A "source" is a labeled agent instance: { label, agent, configDir }. Multiple local accounts
 * (each with its own config folder) are each a source — e.g. "personal" -> ~/.claude.
 *
 * Resolution order:
 *   1. $CLAUDE_DIR set            -> single legacy source { label: $AGENT_LENS_LABEL|"default", ~/.claude type }
 *   2. $AGENT_LENS_CONFIG         -> that JSON file
 *   3. <repo>/agent-lens.config.json
 *   4. <repo>/agent-lens.config.example.json
 *   5. built-in default          -> { label: "default", agent: "claude-code", configDir: "$HOME/.claude" }
 *
 * Prints one TSV line per source: `label<TAB>agent<TAB>configDir` (configDir fully expanded).
 * Importers can also call loadSources().
 *
 * Excluded projects (playgrounds, personal, dummy tests, …) are resolved here too, from the config's
 * top-level `exclude: [<realProjectPath>, …]` plus the `AGENT_LENS_EXCLUDE` env (comma-separated).
 * They are honored at every stage — collect (not mirrored), ingest (not stored / pruned), and the
 * redacted corpus. Run `sources.mjs --excludes` to print the resolved real paths, one per line.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function expand(p) {
  if (!p) return p;
  let out = p;
  if (out === "~") out = homedir();
  else if (out.startsWith("~/")) out = join(homedir(), out.slice(2));
  out = out.replace(/\$HOME/g, homedir());
  return resolve(out);
}

export function loadSources() {
  // 1. legacy single-source override (used by tests and ad-hoc runs)
  if (process.env.CLAUDE_DIR) {
    return [
      {
        label: process.env.AGENT_LENS_LABEL || "default",
        agent: "claude-code",
        configDir: expand(process.env.CLAUDE_DIR),
      },
    ];
  }

  const candidates = [
    process.env.AGENT_LENS_CONFIG,
    join(repoRoot, "agent-lens.config.json"),
    join(repoRoot, "agent-lens.config.example.json"),
  ].filter(Boolean);

  let cfg = null;
  for (const file of candidates) {
    if (file && existsSync(file)) {
      cfg = JSON.parse(readFileSync(file, "utf8"));
      break;
    }
  }
  if (!cfg) cfg = { sources: [{ label: "default", agent: "claude-code", configDir: "$HOME/.claude" }] };

  const seen = new Set();
  const out = [];
  for (const s of cfg.sources || []) {
    if (!s || !s.label || !s.configDir) continue;
    if (seen.has(s.label)) throw new Error(`duplicate source label: ${s.label}`);
    seen.add(s.label);
    out.push({ label: s.label, agent: s.agent || "claude-code", configDir: expand(s.configDir) });
  }
  if (!out.length) throw new Error("no valid sources configured");
  return out;
}

/**
 * Resolve the list of projects to EXCLUDE everywhere (collect, ingest, corpus). Union of the config's
 * `exclude` array and the `AGENT_LENS_EXCLUDE` env (comma-separated). Returns expanded real paths
 * (no trailing slash). The legacy CLAUDE_DIR mode still honors the env var.
 */
export function loadExcludes() {
  const fromEnv = (process.env.AGENT_LENS_EXCLUDE || "").split(",");
  let fromCfg = [];
  if (!process.env.CLAUDE_DIR) {
    const candidates = [process.env.AGENT_LENS_CONFIG, join(repoRoot, "agent-lens.config.json"), join(repoRoot, "agent-lens.config.example.json")].filter(Boolean);
    for (const file of candidates) {
      if (file && existsSync(file)) {
        const cfg = JSON.parse(readFileSync(file, "utf8"));
        fromCfg = Array.isArray(cfg.exclude) ? cfg.exclude : [];
        break;
      }
    }
  }
  const seen = new Set();
  const out = [];
  for (const p of [...fromCfg, ...fromEnv]) {
    const e = expand((p || "").trim());
    if (e && !seen.has(e)) (seen.add(e), out.push(e));
  }
  return out;
}

// When run directly, emit TSV for the shell side (or the exclude list with --excludes).
if (resolve(process.argv[1] || "") === resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.includes("--excludes")) {
    for (const p of loadExcludes()) process.stdout.write(p + "\n");
  } else {
    for (const s of loadSources()) process.stdout.write(`${s.label}\t${s.agent}\t${s.configDir}\n`);
  }
}
