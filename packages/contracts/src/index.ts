/**
 * @agent-lens/contracts — the shapes that cross package boundaries, in two halves:
 *
 * - `./rows.ts`  — normalized DB row shapes, mirroring the DDL in @agent-lens/core (ADR-024)
 * - `./api.ts`   — HTTP response shapes, what the server returns and the SPA consumes (ADR-026)
 *
 * This package is a **pure-types leaf**: zero runtime, zero `node:` imports, so the browser `web`
 * package can share the exact shapes the server emits without pulling Node code into its bundle.
 * Keep it agent-agnostic and free of any value exports — one accidental value export and the
 * node-free guarantee stops being structural.
 *
 * Shared *values* that both Node and browser code need go in `@agent-lens/transcript-format`, which
 * is node-free for the same reason but is allowed to export runtime constants and functions.
 */

export type * from "./rows.js";
export type * from "./api.js";
