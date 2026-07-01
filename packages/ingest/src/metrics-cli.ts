#!/usr/bin/env node
/**
 * Agent Lens — standalone metrics/classification step. Re-runs the heuristic classifier
 * (ADR-004) over an already-ingested DB, without re-reading the archive. Useful after tuning
 * classifier rules: `agent-lens-metrics` (or `node dist/metrics-cli.js`).
 *
 * Usage: agent-lens-metrics [--db <path>]   (env: AGENT_LENS_DB, AGENT_LENS_DATA)
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot, resolveDataDir } from "@agent-lens/core";
import { openDb } from "./db.js";
import { classify, CLASSIFIER_VERSION } from "./classify.js";

function parseArgs(argv: string[]) {
  const a = { db: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") a.db = argv[++i] ?? "";
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = resolveDataDir(findRepoRoot());
  const dbPath = args.db || process.env.AGENT_LENS_DB || join(dataDir, "agent-lens.db");

  if (!existsSync(dbPath)) {
    console.error(`agent-lens-metrics: db not found: ${dbPath} (run ingest first)`);
    process.exit(1);
  }

  const db = openDb(dbPath);
  const r = classify(db);
  db.close();
  console.log(`agent-lens-metrics: classified=${r.count} classifier_version=${CLASSIFIER_VERSION} db=${dbPath}`);
}

main();
