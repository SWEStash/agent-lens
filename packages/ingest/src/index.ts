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
import { readFileSync, statSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  costForUsage,
  findRepoRoot,
  loadExcludes,
  loadSources,
  resolveDataDir,
  type SourceAdapter,
} from "@agent-lens/core";
import { openDb, openRaw, resetSchema } from "./db.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { classify } from "./classify.js";
import { ingestFile, newStats, prepareStatements, pruneExcluded, rebuildDerived } from "./pipeline.js";
import { parseExcludes, isExcludedArchivePath } from "./redact.js";
import { sha256, sha256File, streamLines, STREAM_THRESHOLD } from "./fileread.js";

function parseArgs(argv: string[]) {
  const a = { full: false, db: "", archive: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--full") a.full = true;
    else if (argv[i] === "--db") a.db = argv[++i] ?? "";
    else if (argv[i] === "--archive") a.archive = argv[++i] ?? "";
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = resolveDataDir(findRepoRoot());
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

  // Excluded projects (config `exclude` + AGENT_LENS_EXCLUDE): drop any already-ingested ones now
  // (incremental; --full already reset the DB), then filter them out of discovery below.
  const excludePaths = loadExcludes();
  const excludedDirs = parseExcludes(excludePaths.join(","));
  const pruned = pruneExcluded(db, excludePaths);

  const stmts = prepareStatements(db);
  const stats = newStats();
  // Sessions touched this run; drives the incremental derived rebuild (ADR-010, impacts 2/3).
  const dirty = new Set<string>();

  for (const source of sources) {
    const adapter = adapterById.get(source.agent);
    if (!adapter) {
      console.warn(`agent-lens-ingest: no adapter for agent '${source.agent}' (source '${source.label}') — skipping`);
      continue;
    }
    stmts.insAgent.run(adapter.agentId, adapter.agentName);
    stmts.insSource.run({ id: source.label, label: source.label, agent_id: adapter.agentId, config_dir: source.configDir });

    let files = adapter.discover(join(archiveRoot, source.label), source.label);
    // Drop excluded projects (matches /projects/<encodedDir>/ so nested subagent files go too).
    if (excludedDirs.length) files = files.filter((f) => !isExcludedArchivePath(f.path, excludedDirs));
    // Mirror before versions so the mirror copy wins canonical fields (ON CONFLICT DO NOTHING).
    files.sort((a, b) => Number(a.isVersion) - Number(b.isVersion));

    for (const file of files) {
      stats.files++;
      const st = statSync(file.path);
      const mtimeMs = Math.trunc(st.mtimeMs);
      const prev = args.full
        ? undefined
        : (stmts.getState.get(file.path) as
            | { size: number; mtime_ms: number; sha256: string; events_ingested: number }
            | undefined);

      // (a) Stat short-circuit: an unchanged size+mtime means unchanged content — skip without ever
      // reading or hashing the file. Restores true incrementality across the mirror + every
      // .versions snapshot (ADR-010, impact 1).
      if (prev && prev.size === st.size && prev.mtime_ms === mtimeMs) {
        stats.skipped++;
        continue;
      }

      // Size/mtime moved: read + hash to decide. Whole-file for the common case; stream large files.
      const small = st.size <= STREAM_THRESHOLD;
      const buf = small ? readFileSync(file.path) : null;
      const hash = small ? sha256(buf!) : sha256File(file.path);

      // Content unchanged though mtime moved (e.g. rsync --append-verify re-stat). Skip ingest, but
      // refresh size/mtime so the next run short-circuits on stat alone.
      if (prev && prev.sha256 === hash) {
        stmts.setState.run({
          file_path: file.path,
          size: st.size,
          mtime_ms: mtimeMs,
          sha256: hash,
          events_ingested: prev.events_ingested,
          ingested_at: now,
        });
        stats.skipped++;
        continue;
      }

      const lines = small ? buf!.toString("utf8").split("\n") : streamLines(file.path);
      ingestFile(db, stmts, adapter, file, lines, { size: st.size, mtimeMs, hash }, now, stats);
      dirty.add(file.sessionId);
    }
  }

  // Incremental derived rebuild over only the touched sessions (+ their linkage neighborhood); --full
  // rebuilds everything. classify reuses the expanded set rebuildDerived returns.
  const expanded = rebuildDerived(db, args.full ? null : dirty);

  // Heuristic classification (ADR-004) over the now-stable derived tables. Deterministic +
  // re-runnable; also exposed standalone as `agent-lens-metrics` (see metrics-cli.ts).
  const classified = classify(db, args.full ? null : expanded);

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
    `agent-lens-ingest: files=${stats.files} skipped=${stats.skipped} new_events=${stats.newEvents} malformed=${stats.malformed}${pruned ? ` excluded_pruned=${pruned}` : ""}\n` +
      `  sessions=${sessions} turns=${turns} events=${events} tool_calls=${tools} classified=${classified.count}\n` +
      `  tokens=${totalTokens.toLocaleString()} est_cost=$${cost.toFixed(2)} db=${dbPath}`,
  );
}

main();
