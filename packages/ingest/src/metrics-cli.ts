#!/usr/bin/env node
/**
 * Agent Lens — standalone metrics/classification bin. Thin wrapper over runMetrics (run.ts):
 * re-runs the heuristic classifier (ADR-004) over an already-ingested DB, without re-reading the
 * archive. Useful after tuning classifier rules.
 *
 * Usage: agent-lens-metrics [--db <path>]   (env: AGENT_LENS_DB, AGENT_LENS_DATA)
 */
import { runMetrics } from "./run.js";

runMetrics();
