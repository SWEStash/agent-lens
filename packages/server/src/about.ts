/**
 * GET /api/about — the read-only diagnostics payload (ADR-027).
 *
 * This is the web mirror of `agent-lens config`, plus versions and storage. Two rules make it
 * trustworthy, and both are easy to break by accident:
 *
 * 1. **Report what the server is actually using, not a fresh resolution.** The overridable facts
 *    (db path + its origin, host, port) are passed in from `run.ts`, which resolved them with
 *    precedence flag > env > file > default. Re-resolving them here would silently ignore
 *    `serve --db /custom.db` and report a path nobody is reading.
 * 2. **Never let this reach the static snapshot.** It carries absolute paths and
 *    `export-snapshot.mjs` publishes to a public GitHub Pages demo. The exporter deliberately does
 *    not fetch it; the SPA hides the page under `SNAPSHOT`.
 *
 * Read-only on purpose: config resolves flag > env > file > default, so an editor could only write
 * the third layer and would do nothing at all for anyone using env. Values carry their `origin`
 * instead — the same idiom `agent-lens config` prints.
 */
import { statSync } from "node:fs";
import type { AboutResponse, EngineVersion } from "@agent-lens/contracts";
import {
  loadSources,
  resolveArchiveDir,
  resolveConfigFile,
  resolveDataDir,
  resolveRetention,
  resolveVersion,
  triageDbFor,
  type ConfigOrigin,
} from "@agent-lens/core";
import { CLASSIFIER_VERSION, DETECTOR_VERSION } from "@agent-lens/ingest";
import { type DB, schemaStatus } from "./db.js";
import { queryAll, queryGet, tableExists } from "./sql-util.js";

/** The facts `run.ts` resolved at startup — the ones a flag or env can change. */
export interface AboutContext {
  db: { path: string; origin: ConfigOrigin };
  host: string;
  port: number;
  loopbackOnly: boolean;
  repoRoot: string | null;
}

interface StorageRow {
  files: number;
  bytes: number | null;
  last: string | null;
}

/**
 * Ingested archive bytes, straight from the per-file bookkeeping ingest already maintains
 * (`ingest_state.size`, written by both pipeline.ts and sidecar.ts). No filesystem walk, no cached
 * copy to go stale: measured at ~0.5ms over 7.5k rows, and it is "as of the last ingest" by
 * construction because ingest_state *is* the ingest bookkeeping.
 *
 * This is deliberately NOT `du` of the archive dir — anything present but not ingested (notably
 * `.versions/` retention snapshots) is excluded. The UI says "ingested" for that reason.
 */
function storage(db: DB, dbPath: string): AboutResponse["storage"] {
  const row = tableExists(db, "ingest_state")
    ? queryGet<StorageRow>(db, "SELECT COUNT(*) files, SUM(size) bytes, MAX(ingested_at) last FROM ingest_state")
    : undefined;

  let db_bytes: number | null = null;
  try {
    db_bytes = statSync(dbPath).size;
  } catch {
    db_bytes = null; // path moved out from under a running server — report unknown, don't throw
  }

  return {
    db_bytes,
    archive_bytes: row?.bytes ?? 0, // SUM over zero rows is NULL, not 0
    archive_files: row?.files ?? 0,
    last_ingested: row?.last ?? null,
  };
}

/**
 * What a stamped engine produces now vs what is actually stored. The stored side is the point: it
 * answers "were these findings produced by the rules this build has?", which is invisible otherwise
 * and is what tells you a re-run (`agent-lens ingest --full`, `agent-lens metrics`) is pending.
 *
 * Rows stamped NEWER than this build are possible too — an older server reading a DB a newer ingest
 * wrote — and are deliberately not flagged `stale`: re-running would *downgrade* them.
 */
function engineVersion(db: DB, table: string, sql: string, expected: number): EngineVersion {
  // `sql` is a literal at each call site — no identifier is ever interpolated here (SLOP-071).
  const in_data = tableExists(db, table)
    ? queryAll<{ v: number }>(db, sql)
        .map((r) => r.v)
        .filter((v) => Number.isFinite(v))
    : [];
  return { expected, in_data, stale: in_data.some((v) => v < expected) };
}

export function about(db: DB, ctx: AboutContext): AboutResponse {
  const version = resolveVersion();
  const schema = schemaStatus(db);
  const dataDir = resolveDataDir(ctx.repoRoot);
  const retention = resolveRetention();

  return {
    versions: {
      app: version.version,
      app_source: version.source,
      schema: schema.db_version,
      schema_expected: schema.expected,
      schema_stale: schema.stale,
      detector: engineVersion(
        db,
        "findings",
        "SELECT DISTINCT detector_version v FROM findings ORDER BY v",
        DETECTOR_VERSION,
      ),
      classifier: engineVersion(
        db,
        "classifications",
        "SELECT DISTINCT classifier_version v FROM classifications ORDER BY v",
        CLASSIFIER_VERSION,
      ),
    },
    paths: {
      config_file: resolveConfigFile(ctx.repoRoot, dataDir),
      data_dir: { path: dataDir, origin: process.env.AGENT_LENS_DATA ? "env" : "default" },
      // archive and triage_db are "fixed": ADR-021 makes them non-relocatable on their own, so they
      // are derived here with the same core helpers the CLI uses rather than read from config.
      archive: { path: resolveArchiveDir(ctx.repoRoot), origin: "fixed" },
      db: { path: ctx.db.path, origin: ctx.db.origin },
      triage_db: { path: triageDbFor(ctx.db.path), origin: "fixed" },
    },
    server: { host: ctx.host, port: ctx.port, loopback_only: ctx.loopbackOnly },
    retention: { versions_keep_days: retention.keepDays, origin: retention.origin },
    sources: loadSources().map((s) => ({ label: s.label, agent: s.agent, config_dir: s.configDir })),
    // storage() already carries last_ingested from the same MAX(ingested_at) it aggregates over —
    // reusing it avoids a second query AND keeps the tableExists guard that lastIngested() lacks.
    storage: storage(db, ctx.db.path),
  };
}
