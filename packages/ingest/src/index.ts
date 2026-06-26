#!/usr/bin/env node
/**
 * Agent Lens — Stage 2 ingest CLI (ADR-001, ADR-003).
 *
 * Reads the raw archive (mirror + .versions divergence backups), deduplicates events by `uuid`,
 * and (re)builds the normalized SQLite store. Idempotent: unchanged files are skipped via
 * ingest_state; events are inserted with ON CONFLICT DO NOTHING so re-runs add nothing.
 *
 * This file is the CLI bootstrap (argv/env, source resolution, disk walk, incremental-skip, report);
 * the DB-writing engine lives in pipeline.ts so it can be unit-tested in-process.
 *
 * Usage: agent-lens-ingest [--full] [--db <path>] [--archive <path>]
 *   --full   ignore ingest_state and re-read every file
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { costForUsage, type SourceAdapter } from "@agent-lens/core";
import { openDb, openRaw, resetSchema } from "./db.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { classify } from "./classify.js";
import { ingestFile, newStats, prepareStatements, rebuildDerived } from "./pipeline.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface Source {
  label: string;
  agent: string;
  configDir: string;
}

/** Resolve configured sources via the canonical resolver (shared with collect.sh). */
function loadSources(): Source[] {
  const tsv = execFileSync("node", [join(repoRoot, "scripts/sources.mjs")], { encoding: "utf8" });
  const out: Source[] = [];
  for (const line of tsv.split("\n")) {
    if (!line.trim()) continue;
    const [label, agent, configDir] = line.split("\t");
    out.push({ label: label!, agent: agent!, configDir: configDir! });
  }
  return out;
}

function parseArgs(argv: string[]) {
  const a = { full: false, db: "", archive: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--full") a.full = true;
    else if (argv[i] === "--db") a.db = argv[++i] ?? "";
    else if (argv[i] === "--archive") a.archive = argv[++i] ?? "";
  }
  return a;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = process.env.AGENT_LENS_DATA || join(repoRoot, "data");
  const archiveRoot = args.archive || process.env.AGENT_LENS_ARCHIVE || join(dataDir, "archive");
  const dbPath = args.db || process.env.AGENT_LENS_DB || join(dataDir, "agent-lens.db");

  if (!existsSync(archiveRoot)) {
    console.error(`agent-lens-ingest: archive not found: ${archiveRoot} (run scripts/collect.sh first)`);
    process.exit(1);
  }
  mkdirSync(dirname(dbPath), { recursive: true });

  // --full: open WITHOUT applying schema (the on-disk schema may be a stale version), then
  // drop+recreate from the archive (source of truth). This is also the migration path — a
  // SCHEMA_VERSION bump's new columns take effect here without a separate migration step.
  const db = args.full ? openRaw(dbPath) : openDb(dbPath);
  if (args.full) resetSchema(db);

  // Adapter registry keyed by agent type; configured sources resolved by the shared resolver.
  const adapterList: SourceAdapter[] = [new ClaudeCodeAdapter()];
  const adapterById = new Map(adapterList.map((a) => [a.agentId, a]));
  const sources = loadSources();
  const now = new Date().toISOString();

  const stmts = prepareStatements(db);
  const stats = newStats();

  for (const source of sources) {
    const adapter = adapterById.get(source.agent);
    if (!adapter) {
      console.warn(`agent-lens-ingest: no adapter for agent '${source.agent}' (source '${source.label}') — skipping`);
      continue;
    }
    stmts.insAgent.run(adapter.agentId, adapter.agentName);
    stmts.insSource.run({ id: source.label, label: source.label, agent_id: adapter.agentId, config_dir: source.configDir });

    const files = adapter.discover(join(archiveRoot, source.label), source.label);
    // Mirror before versions so the mirror copy wins canonical fields (ON CONFLICT DO NOTHING).
    files.sort((a, b) => Number(a.isVersion) - Number(b.isVersion));

    for (const file of files) {
      stats.files++;
      const st = statSync(file.path);
      const buf = readFileSync(file.path);
      const hash = sha256(buf);
      if (!args.full) {
        const prev = stmts.getState.get(file.path) as { sha256: string } | undefined;
        if (prev && prev.sha256 === hash) {
          stats.skipped++;
          continue;
        }
      }
      ingestFile(db, stmts, adapter, file, buf.toString("utf8"), { size: st.size, mtimeMs: st.mtimeMs, hash }, now, stats);
    }
  }

  rebuildDerived(db);

  // Heuristic classification (ADR-004) over the now-stable derived tables. Deterministic +
  // re-runnable; also exposed standalone as `agent-lens-metrics` (see metrics-cli.ts).
  const classified = classify(db);

  // Report.
  const count = (sql: string) => (db.prepare(sql).get() as any).n as number;
  const sessions = count("SELECT COUNT(*) n FROM sessions");
  const turns = count("SELECT COUNT(*) n FROM turns");
  const events = count("SELECT COUNT(*) n FROM events");
  const tools = count("SELECT COUNT(*) n FROM tool_calls");
  const usageRows = db
    .prepare("SELECT model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens FROM token_usage")
    .all() as any[];
  let cost = 0;
  let totalTokens = 0;
  for (const u of usageRows) {
    cost += costForUsage(u.model, u);
    totalTokens += u.input_tokens + u.output_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
  }

  db.close();
  console.log(
    `agent-lens-ingest: files=${stats.files} skipped=${stats.skipped} new_events=${stats.newEvents} malformed=${stats.malformed}\n` +
      `  sessions=${sessions} turns=${turns} events=${events} tool_calls=${tools} classified=${classified.count}\n` +
      `  tokens=${totalTokens.toLocaleString()} est_cost=$${cost.toFixed(2)} db=${dbPath}`,
  );
}

main();
