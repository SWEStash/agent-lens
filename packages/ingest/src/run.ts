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
  ANALYZE_SQL,
  costForUsage,
  installPricing,
  loadExcludes,
  loadSources,
  rateForModel,
  resolveArchiveDir,
  resolveDbPath,
  SCHEMA_VERSION,
  SYNTHETIC_MODEL,
  transaction,
  type SourceAdapter,
} from "@agent-lens/core";
import { finishBulkLoad, openDb, openRaw, resetSchema, SchemaMismatchError, type DB } from "./db.js";
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
import { encodeProjectPath, isExcludedArchivePath } from "./redact.js";
import { sha256, sha256File, streamLines, STREAM_THRESHOLD } from "./fileread.js";
import { compareIngestOrder, contentSpan } from "./ingestorder.js";
import { assertForeignKeys } from "./fkcheck.js";

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
 * - `ingest`: genuinely new/changed. Its bytes are read again when it is ingested, after the run has
 *   put its files in content order (ADR-038). */
type FileDecision =
  | { action: "skip-stat" }
  | { action: "skip-hash"; hash: string }
  | { action: "ingest"; hash: string };

function shouldReingest(path: string, size: number, mtimeMs: number, prev: FileState): FileDecision {
  if (prev && prev.size === size && prev.mtime_ms === mtimeMs) return { action: "skip-stat" };

  // Size/mtime moved: read + hash to decide. Whole-file for the common case; stream large files.
  const hash = size <= STREAM_THRESHOLD ? sha256(readFileSync(path)) : sha256File(path);

  if (prev && prev.sha256 === hash) return { action: "skip-hash", hash };
  return { action: "ingest", hash };
}

/** openDb, but a stale store ends the process with the rebuild hint instead of a stack trace. */
function openOrExplain(dbPath: string, tool: string): DB {
  try {
    return openDb(dbPath);
  } catch (err) {
    if (!(err instanceof SchemaMismatchError)) throw err;
    console.error(`${tool}: ${err.message}`);
    process.exit(1);
  }
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
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const sessions = count("SELECT COUNT(*) n FROM sessions");
  const turns = count("SELECT COUNT(*) n FROM turns");
  const events = count("SELECT COUNT(*) n FROM events");
  const tools = count("SELECT COUNT(*) n FROM tool_calls");
  const usageRows = db
    .prepare("SELECT model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens FROM token_usage")
    .all() as Array<{
    model: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  }>;
  let cost = 0;
  let totalTokens = 0;
  // A model with no rate contributes $0 silently (ADR-028) — that is how a whole week of sessions
  // once read as free. Tally it here, where a human is watching the run, instead of letting the
  // estimate quietly understate itself.
  const unpriced = new Map<string, number>();
  for (const u of usageRows) {
    cost += costForUsage(u.model, u);
    totalTokens += u.input_tokens + u.output_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
    if (u.model && u.model !== SYNTHETIC_MODEL && !rateForModel(u.model)) {
      unpriced.set(u.model, (unpriced.get(u.model) ?? 0) + 1);
    }
  }
  const unpricedLine = unpriced.size
    ? `\n  unpriced=${unpriced.size} model(s): ` +
      [...unpriced].map(([m, n]) => `${m} (${n} records)`).join(", ") +
      ` — cost above excludes them; add rates under "pricing" in agent-lens.config.json`
    : "";

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
      `  tokens=${totalTokens.toLocaleString()} est_cost=$${cost.toFixed(2)} db=${dbPath}` +
      unpricedLine,
  );
}

// This module is the package entry (`exports: ./dist/run.js`), so re-export the stamped engine
// versions here: the server's /api/about reports what a re-run would produce against what is
// actually stamped in the stored rows (ADR-027). Importing them from ./detect.js or ./classify.js
// across the package boundary would reach past the public surface.
export { CLASSIFIER_VERSION } from "./classify.js";
export { DETECTOR_VERSION } from "./detect.js";

/** Stage 2: (re)build the derived SQLite store from the local archive. Idempotent. */
export function runIngest(argv: string[] = process.argv.slice(2)): void {
  const args = parseIngestArgs(argv);
  // --archive stays as an explicit per-run override (ingesting a copied archive); there is no
  // env/config equivalent — the location is fixed so collect and ingest can never disagree (ADR-021).
  const archiveRoot = args.archive || resolveArchiveDir();
  const { path: dbPath } = resolveDbPath(args.db);
  // Cost in the end-of-run report is derived through the effective table (ADR-028), so install any
  // config overrides before the report — and warn here about malformed ones, where a human is looking.
  installPricing();

  if (!existsSync(archiveRoot)) {
    console.error(`agent-lens-ingest: archive not found: ${archiveRoot} (run 'agent-lens collect' first)`);
    process.exit(1);
  }
  mkdirSync(dirname(dbPath), { recursive: true });

  // --full: open WITHOUT applying schema (the on-disk schema may be a stale version), then
  // drop+recreate from the archive (source of truth). This is also the migration path — a
  // SCHEMA_VERSION bump's new columns take effect here without a separate migration step.
  // Schema guard: openDb refuses a store stamped by another build before touching its schema, since
  // an incremental ingest cannot migrate existing tables. `ingest --full` (drop+recreate) is the
  // migration path.
  const db = args.full ? openRaw(dbPath) : openOrExplain(dbPath, "agent-lens-ingest");

  // Adapter registry keyed by agent type; configured sources resolved by the shared resolver.
  const adapterList: SourceAdapter[] = [new ClaudeCodeAdapter()];
  const adapterById = new Map(adapterList.map((a) => [a.agentId, a]));
  const sources = loadSources();
  const now = new Date().toISOString();

  // Excluded projects (config `exclude` + AGENT_LENS_EXCLUDE): drop any already-ingested ones now,
  // then filter them out of discovery below.
  const excludePaths = loadExcludes();
  const excludedDirs = excludePaths.map(encodeProjectPath);
  // --full skips it: the rebuild below starts from empty tables, and the old schema may be stale.
  const pruned = args.full ? 0 : pruneExcluded(db, excludePaths);

  // The rest of the run is one transaction. The server keeps reading the previous state until it
  // commits, instead of the empty or half-filled tables a --full rebuild used to show it for minutes,
  // and a failed run rolls back whole. It also replaces a commit and WAL checkpoint per file with one.
  // --full runs with foreign keys off, because resetSchema's drops need that and the PRAGMA is a
  // no-op inside a transaction. foreign_key_check before the commit puts the guarantee back.
  // rebuildDerived defers foreign keys to this commit, so a violation there fails the run as a whole.
  if (args.full) db.exec("PRAGMA foreign_keys = OFF");
  let report: Omit<IngestReport, "pruned">;
  try {
    report = transaction(db, () => {
      // --full fills the tables from empty, so four events indexes and FTS are built once after the
      // load rather than per row (BULK_DEFERRED).
      if (args.full) resetSchema(db, { bulk: true });

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
        // Decide every file first, then ingest the changed ones in content order (ADR-038): an event
        // belongs to the first session that stores it, so an original must precede the sessions that
        // repeat its lines. The order also puts the mirror before .versions/, so the mirror's copy of
        // a line wins its canonical fields (ON CONFLICT DO NOTHING).
        const pending = [];
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
          // Keep the hash, not decision.buf: holding every pending file's bytes would put the whole
          // archive in memory on --full. The re-read below is served from the page cache.
          pending.push({ file, path: file.path, isVersion: file.isVersion, span: contentSpan(file.path), size: st.size, mtimeMs, hash: decision.hash });
        }
        pending.sort(compareIngestOrder);

        for (const { file, size, mtimeMs, hash } of pending) {
          const lines = size <= STREAM_THRESHOLD ? readFileSync(file.path, "utf8").split("\n") : streamLines(file.path);
          ingestFile(db, stmts, adapter, file, lines, { size, mtimeMs, hash }, now, stats, { provisionalTurns: args.full });
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
      // After rebuildDerived's per-event turn_id update, before the passes and ANALYZE that read them.
      if (args.full) finishBulkLoad(db);

      const { classified, detected, fileChanges } = runDerivedPasses(db, args.full ? null : expanded);

      // Planner statistics, last, so they describe the tables as the server will read them. The
      // dashboard's covering indexes only win with stats present (see ANALYZE_SQL).
      db.exec(ANALYZE_SQL);

      // Every run, not just --full: deferred foreign keys would otherwise fail at COMMIT with no
      // table, key or session named (ADR-038). ~1.5 s on a 3 GB store.
      assertForeignKeys(db);
      return { stats, classified, detected, fileChanges, wfStats, metaStats, trStats };
    })();
  } finally {
    if (args.full) db.exec("PRAGMA foreign_keys = ON");
  }

  // A --full run leaves a WAL as large as the whole store. Truncate it now rather than on the next
  // ingest that writes. With no busy handler this does not wait: if the server is mid-read it
  // reports busy and returns, and WAL_SIZE_LIMIT trims the file on a later run instead.
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

  printIngestReport(db, dbPath, { ...report, pruned });
}

/**
 * The deterministic, re-runnable passes over the derived tables, in dependency order. Shared by ingest
 * and `agent-lens metrics` so the two cannot run different sequences. `scope` is the expanded dirty
 * set rebuildDerived returns; null runs every pass over everything.
 */
function runDerivedPasses(db: DB, scope: Set<string> | null) {
  // Canonical project roots (ADR-023) first: classify, detect and file changes all read the session's
  // project path. Global (the table is a few dozen rows), so an existing DB heals without --full.
  canonicalizeProjects(db);
  return {
    classified: classify(db, scope), // heuristic categories (ADR-004)
    detected: detect(db, scope), // security findings (ADR-017)
    errors: classifyErrors(db, scope), // error_type on errored tool calls
    fileChanges: deriveFileChanges(db, scope), // file provenance (ADR-022), incl. Bash shell writes
  };
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

  const db = openOrExplain(dbPath, "agent-lens-metrics");
  const { classified: r, detected: d, errors: e, fileChanges: fc } = runDerivedPasses(db, null);
  db.close();
  console.log(
    `agent-lens-metrics: classified=${r.count} classifier_version=${CLASSIFIER_VERSION} ` +
      `findings=${d.count} detector_version=${DETECTOR_VERSION} errors_classified=${e.count} error_classifier_version=${e.version} ` +
      `file_changes=${fc.count} filechanges_version=${FILECHANGES_VERSION} db=${dbPath}`,
  );
}
