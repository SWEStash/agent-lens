#!/usr/bin/env node
/**
 * Agent Lens — Stage 3 local server bin (ADR-005). Thin bin: forwards to startServer (run.ts).
 * Kept so `node dist/index.js` / the legacy `agent-lens-server` bin still work; the unified CLI
 * imports startServer directly instead.
 *
 * Usage: agent-lens-server   (env: AGENT_LENS_DB, AGENT_LENS_PORT, AGENT_LENS_HOST)
 */
import { startServer } from "./run.js";

await startServer();
