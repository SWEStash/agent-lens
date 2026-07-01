#!/usr/bin/env node
/**
 * Agent Lens — Stage 2 ingest CLI bin (ADR-001, ADR-003).
 *
 * Thin bin: forwards argv to runIngest (run.ts). Kept so `node dist/index.js` / the legacy
 * `agent-lens-ingest` bin still work; the unified CLI imports runIngest directly instead.
 *
 * Usage: agent-lens-ingest [--full] [--db <path>] [--archive <path>]
 */
import { runIngest } from "./run.js";

runIngest();
