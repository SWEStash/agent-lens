/**
 * Agent Lens — Stage 2 ingest, as importable functions (ADR-001, ADR-003).
 *
 * `runIngest` and `runMetrics` are the library entrypoints so the unified `agent-lens` CLI can
 * bundle and call them in-process; the thin bins in index.ts / metrics-cli.ts just forward argv.
 * The DB-writing engine lives in pipeline.ts (unit-tested in-process).
 */
import { readFileSync, statSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  costForUsage,
  loadExcludes,
  loadSources,
  resolveArchiveDir,
  resolveDbPath,
  SCHEMA_VERSION,
  type SourceAdapter,
} from "@agent-lens/core";
import { openDb, openRaw, readSchemaVersion, resetSchema, type DB } from "./db.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { classify, CLASSIFIER_VERSION } from "./classify.js";
import { detect, DETECTOR_VERSION } from "./detect.js";
import { classifyErrors } from "./errors.js";
import { deriveFileChanges, FILECHANGES_VERSION } from "./filechanges.js";
import { canonicalizeProjects } from "./canonicalize.js";
import { ingestFile, newStats, prepareStatements, pruneExcluded, rebuildDerived, type IngestStats } from "./pipeline.js";
import { ingestWorkflowResults, newWorkflowStats } from "./workflows.js";
import { ingestSubagentMeta, newMetaStats } from "./meta.js";
import { ingestToolResults, newToolResultStats } from "./toolResults.js";
import { parseExcludes, isExcludedArchivePath } from "./redact.js";
import { sha256, sha256File, streamLines, STREAM_THRESHOLD } from "./fileread.js";

function parseIngestArgs(argv: string[]) {
  const a = { full: false, db: "", archive: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--full") a.full = true;
    else if (argv[i] === "--db") a.db = argv[++i] ?? "";
    else if (argv[i] === "--archive") a.archive = argv[++i] ?? "";
  }
  return a;
}

/** Skip-state for one archive file, as recorded by the previous run. */
type FileState = { size: number; mtime_ms: number; sha256: string; events_ingested: number } | undefined;

/** What to do with one archive file this run.
 * - `skip-stat`: unchanged size+mtime means unchanged content — skip without ever reading or hashing
 *   the file. This is what restores true incrementality across the mirror + every .versions snapshot
 *   (ADR-010, impact 1).
 * - `skip-hash`: content is unchanged though mtime moved (e.g. an rsync --append-verify re-stat) —
 *   skip the ingest but refresh size/mtime so the next run short-circuits on stat alone.
 * - `ingest`: genuinely new/changed. `buf` is the whole file for the common case, null for a large
 *   file that must be streamed instead. */
type FileDecision =
  | { action: "skip-stat" }
  | { action: "skip-hash"; hash: string }
  | { action: "ingest"; hash: string; buf: Buffer | null };

function shouldReingest(path: string, size: number, mtimeMs: number, prev: FileState): FileDecision {
  if (prev && prev.size === size && prev.mtime_ms === mtimeMs) return { action: "skip-stat" };

  // Size/mtime moved: read + hash to decide. Whole-file for the common case; stream large files.
  const small = size <= STREAM_THRESHOLD;
  const buf = small ? readFileSync(path) : null;
  const hash = small ? sha256(buf!) : sha256File(path);

  if (prev && prev.sha256 === hash) return { action: "skip-hash", hash };
  return { action: "ingest", hash, buf };
}

/** Everything the end-of-run report counts, gathered from the callers that produced it. */
interface IngestReport {
  stats: IngestStats;
  pruned: number;
  classified: { count: number };
  detected: { count: number };
  fileChanges: { count: number };
  wfStats: { upserted: number; skipped: number; malformed: number };
  metaStats: { upserted: number; skipped: number; malformed: number };
  trStats: { upserted: number; skipped: number; malformed: number };
}

/** Tally the final table counts, close the DB, and print the one-block run summary. */
function printIngestReport(db: DB, dbPath: string, r: IngestReport): void {
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

  const wfRuns = count("SELECT COUNT(*) n FROM workflow_results");
  const metaRows = count("SELECT COUNT(*) n FROM session_meta");
  const trRows = count("SELECT COUNT(*) n FROM tool_results");
  const sevCounts = db
    .prepare("SELECT severity, COUNT(*) n FROM findings GROUP BY severity")
    .all() as Array<{ severity: string; n: number }>;
  const sevMap = Object.fromEntries(sevCounts.map((s) => [s.severity, s.n]));
  const sevLine = ["critical", "high", "medium", "low", "info"].map((s) => `${s}=${sevMap[s] ?? 0}`).join(" ");

  db.close();
  console.log(
    `agent-lens-ingest: files=${r.stats.files} skipped=${r.stats.skipped} new_events=${r.stats.newEvents} malformed=${r.stats.malformed}${r.pruned ? ` excluded_pruned=${r.pruned}` : ""}\n` +
      `  sessions=${sessions} turns=${turns} events=${events} tool_calls=${tools} classified=${r.classified.count}\n` +
      `  workflow_results=${wfRuns} (sidecar upserted=${r.wfStats.upserted} skipped=${r.wfStats.skipped} malformed=${r.wfStats.malformed})\n` +
      `  session_meta=${metaRows} (upserted=${r.metaStats.upserted} skipped=${r.metaStats.skipped} malformed=${r.metaStats.malformed})\n` +
      `  tool_results=${trRows} (upserted=${r.trStats.upserted} skipped=${r.trStats.skipped} malformed=${r.trStats.malformed})\n` +
      `  findings=${r.detected.count} (${sevLine})\n` +
      `  file_changes=${r.fileChanges.count}\n` +
      `  tokens=${totalTokens.toLocaleString()} est_cost=$${cost.toFixed(2)} db=${dbPath}`,
  );
}

/** Stage 2: (re)build the derived SQLite store from the local archive. Idempotent. */
// This module is the package entry (`exports: ./dist/run.js`), so re-export the stamped engine
// versions here: the server's /api/about reports what a re-run would produce against what is
// actually stamped in the stored rows (ADR-027). Importing them from ./detect.js or ./classify.js
// across the package boundary would reach past the public surface.
export { CLASSIFIER_VERSION } from "./classify.js";
export { DETECTOR_VERSION } from "./detect.js";

export function runIngest(argv: string[] = process.argv.slice(2)): void {
  const args = parseIngestArgs(argv);
  // --archive stays as an explicit per-run override (ingesting a copied archive); there is no
  // env/config equivalent — the location is fixed so collect and ingest can never disagree (ADR-021).
  const archiveRoot = args.archive || resolveArchiveDir();
  const { path: dbPath } = resolveDbPath(args.db);

  if (!existsSync(archiveRoot)) {
    console.error(`agent-lens-ingest: archive not found: ${archiveRoot} (run 'agent-lens collect' first)`);
    process.exit(1);
  }
  mkdirSync(dirname(dbPath), { recursive: true });

  // --full: open WITHOUT applying schema (the on-disk schema may be a stale version), then
  // drop+recreate from the archive (source of truth). This is also the migration path — a
  // SCHEMA_VERSION bump's new columns take effect here without a separate migration step.
  const db = args.full ? openRaw(dbPath) : openDb(dbPath);
  if (args.full) {
    resetSchema(db);
  } else {
    // Schema guard: an incremental ingest only runs CREATE IF NOT EXISTS — it adds new tables but
    // cannot migrate altered columns on existing ones, and never advances the stamp (applySchema is
    // stamp-if-absent). So a DB stamped by an older build is stale: refuse rather than silently ingest
    // into a half-migrated schema. `ingest --full` (drop+recreate) is the migration path.
    const dbVer = readSchemaVersion(db);
    if (dbVer != null && dbVer !== SCHEMA_VERSION) {
      console.error(
        `agent-lens-ingest: schema mismatch — DB is v${dbVer}, this build expects v${SCHEMA_VERSION}. ` +
          `Run 'agent-lens ingest --full' to rebuild.`,
      );
      db.close();
      process.exit(1);
    }
  }

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
  const wfStats = newWorkflowStats();
  const metaStats = newMetaStats();
  const trStats = newToolResultStats();
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
      const prev = args.full ? undefined : (stmts.getState.get(file.path) as FileState);

      const decision = shouldReingest(file.path, st.size, mtimeMs, prev);
      if (decision.action === "skip-stat") {
        stats.skipped++;
        continue;
      }
      if (decision.action === "skip-hash") {
        stmts.setState.run({
          file_path: file.path,
          size: st.size,
          mtime_ms: mtimeMs,
          sha256: decision.hash,
          events_ingested: prev!.events_ingested,
          ingested_at: now,
        });
        stats.skipped++;
        continue;
      }

      const lines = decision.buf ? decision.buf.toString("utf8").split("\n") : streamLines(file.path);
      ingestFile(db, stmts, adapter, file, lines, { size: st.size, mtimeMs, hash: decision.hash }, now, stats);
      dirty.add(file.sessionId);
    }

    // Workflow-tool result sidecars (wf_<id>.json) — the authoritative record of how each run
    // finished; not *.jsonl, so the transcript walk above never sees them. Own table, own skip-state.
    ingestWorkflowResults(db, join(archiveRoot, source.label), source.label, excludedDirs, now, wfStats, args.full);

    // Per-subagent metadata (subagents/agent-<id>.meta.json) — the authoritative agentType/description/
    // spawnDepth; joined onto sessions at read time. Own table (session_meta), own skip-state.
    ingestSubagentMeta(db, join(archiveRoot, source.label), source.label, excludedDirs, now, metaStats, args.full);

    // Spilled full tool outputs (tool-results/<name>.txt) — the un-truncated result the transcript only
    // summarized; joined onto tool_calls at read time via the summary's marker. Own table, own skip-state.
    ingestToolResults(db, join(archiveRoot, source.label), excludedDirs, now, trStats, args.full);
  }

  // Incremental derived rebuild over only the touched sessions (+ their linkage neighborhood); --full
  // rebuilds everything. classify reuses the expanded set rebuildDerived returns.
  const expanded = rebuildDerived(db, args.full ? null : dirty);

  // Canonical project roots (ADR-023): fold cwd-grained project rows into their git root (or
  // observed ancestor) BEFORE the passes below — classify/detect/file-changes all consume the
  // session's project path. Global + re-runnable (the table is a few dozen rows), so an existing
  // DB heals on its next ingest without --full.
  canonicalizeProjects(db);

  // Heuristic classification (ADR-004) over the now-stable derived tables. Deterministic +
  // re-runnable; also exposed standalone as `agent-lens metrics` (see runMetrics).
  const classified = classify(db, args.full ? null : expanded);

  // Security findings (ADR-017) over the same derived tool_calls. Deterministic + re-runnable; the
  // detector reuses the expanded dirty set and delete-then-inserts the touched sessions' findings.
  const detected = detect(db, args.full ? null : expanded);

  // Tool-error classification (error_type on errored tool_calls). Deterministic + re-runnable; reuses
  // the same expanded dirty set. Powers the sessions error-type filter + dashboard/detail breakdowns.
  classifyErrors(db, args.full ? null : expanded);

  // File-modification provenance (ADR-022) from Edit/Write/NotebookEdit inputs. Deterministic +
  // re-runnable; reuses the same expanded dirty set and delete-then-inserts per touched session.
  const fileChanges = deriveFileChanges(db, args.full ? null : expanded);

  printIngestReport(db, dbPath, { stats, pruned, classified, detected, fileChanges, wfStats, metaStats, trStats });
}

/** Standalone reclassification over an already-ingested DB (no archive re-read). */
export function runMetrics(argv: string[] = process.argv.slice(2)): void {
  let dbArg = "";
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--db") dbArg = argv[++i] ?? "";
  const { path: dbPath } = resolveDbPath(dbArg);

  if (!existsSync(dbPath)) {
    console.error(`agent-lens-metrics: db not found: ${dbPath} (run ingest first)`);
    process.exit(1);
  }

  const db = openDb(dbPath);
  canonicalizeProjects(db); // ADR-023 — heal cwd-grained projects before the passes read them
  const r = classify(db);
  const d = detect(db);
  const e = classifyErrors(db);
  const fc = deriveFileChanges(db);
  db.close();
  console.log(
    `agent-lens-metrics: classified=${r.count} classifier_version=${CLASSIFIER_VERSION} ` +
      `findings=${d.count} detector_version=${DETECTOR_VERSION} errors_classified=${e.count} error_classifier_version=${e.version} ` +
      `file_changes=${fc.count} filechanges_version=${FILECHANGES_VERSION} db=${dbPath}`,
  );
}
