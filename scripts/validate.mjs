#!/usr/bin/env node
/**
 * Agent Lens — data-correctness invariant suite (Layer 2 of the validation plan).
 *
 * Opens a SQLite DB READ-ONLY and asserts reconciliation invariants that must hold for ANY corpus —
 * no hand-authored expected values, so it runs at full real scale (hundreds of sessions). It also
 * cross-checks the REAL server aggregation path (dashboardOverview) against direct SUMs, and the
 * derived cost against a row-by-row recomputation, so a bug in the shipped query surfaces here.
 *
 * Usage:  node scripts/validate.mjs [--db <path>]
 * Default --db is a COPY convention: never point this at the live WAL DB while ingest runs; copy it
 * first (cp data/agent-lens.db /tmp/al-validate.db) so you read a consistent snapshot.
 *
 * Exit code: non-zero if any HARD invariant fails. SOFT findings (orphans, unpriced models,
 * unattributed rows) are reported but never fail the run — they feed docs/VALIDATION.md.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { costForUsage, rateForModel } from "../packages/core/dist/pricing.js";
import { dashboardOverview } from "../packages/server/dist/dashboard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// better-sqlite3 lives in the packages' node_modules (pnpm), not the repo root — resolve it there.
const Database = createRequire(join(__dirname, "../packages/ingest/package.json"))("better-sqlite3");
const argv = process.argv.slice(2);
const dbIdx = argv.indexOf("--db");
const dbPath = dbIdx >= 0 ? argv[dbIdx + 1] : join(__dirname, "..", "data", "agent-lens.db");

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
db.pragma("query_only = ON");

let hardFail = 0;
const line = (s) => process.stdout.write(s + "\n");
function hard(name, ok, detail = "") {
  if (!ok) hardFail++;
  line(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
function soft(name, detail) {
  line(`  INFO  ${name}${detail ? "  — " + detail : ""}`);
}
const q1 = (sql, ...p) => db.prepare(sql).get(...p);
const qa = (sql, ...p) => db.prepare(sql).all(...p);
const fmt = (n) => Number(n).toLocaleString("en-US");

line(`\nAgent Lens validation — ${dbPath}`);
line(`sessions=${fmt(q1("SELECT COUNT(*) n FROM sessions").n)} events=${fmt(q1("SELECT COUNT(*) n FROM events").n)} token_rows=${fmt(q1("SELECT COUNT(*) n FROM token_usage").n)}\n`);

// 1) Token dedup — no (session_id, message_id) collapsed-response key has >1 row.
line("[1] Token dedup");
{
  const dups = q1(
    "SELECT COUNT(*) n FROM (SELECT session_id, message_id, COUNT(*) c FROM token_usage WHERE message_id IS NOT NULL GROUP BY session_id, message_id HAVING c > 1)",
  ).n;
  hard("each (session_id, message_id) appears once", dups === 0, `${dups} duplicate groups`);
}

// 2) Conservation — the shipped dashboardOverview totals must equal direct SUMs over token_usage.
line("[2] Conservation (dashboardOverview vs direct SUM)");
{
  const ov = dashboardOverview(db, {});
  const raw = q1(
    "SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(cache_creation_input_tokens),0) cw, COALESCE(SUM(cache_read_input_tokens),0) cr FROM token_usage",
  );
  hard("overview.input == SUM(input_tokens)", ov.tokens.input === raw.i, `${fmt(ov.tokens.input)} vs ${fmt(raw.i)}`);
  hard("overview.output == SUM(output_tokens)", ov.tokens.output === raw.o, `${fmt(ov.tokens.output)} vs ${fmt(raw.o)}`);
  hard("overview.cache_creation == SUM(cache_creation)", ov.tokens.cache_creation === raw.cw);
  hard("overview.cache_read == SUM(cache_read)", ov.tokens.cache_read === raw.cr, `${fmt(ov.tokens.cache_read)} vs ${fmt(raw.cr)}`);
  hard("overview.total_tokens == sum of the four classes", ov.total_tokens === raw.i + raw.o + raw.cw + raw.cr);

  // 3) Cost additivity — row-by-row recomputation must match the grouped overview cost.
  let rowCost = 0;
  for (const r of qa("SELECT model, input_tokens i, output_tokens o, cache_creation_input_tokens cw, cache_read_input_tokens cr FROM token_usage")) {
    rowCost += costForUsage(r.model, { input_tokens: r.i, output_tokens: r.o, cache_creation_input_tokens: r.cw, cache_read_input_tokens: r.cr });
  }
  const drift = Math.abs(rowCost - ov.cost);
  line("[3] Cost additivity");
  hard("Σ costForUsage(row) == overview.cost", drift < 0.01, `row=$${rowCost.toFixed(4)} overview=$${ov.cost.toFixed(4)} drift=$${drift.toFixed(6)}`);
  soft("derived cost", `$${ov.cost.toFixed(2)}  cache_read_ratio=${(ov.cache_read_ratio * 100).toFixed(1)}%`);
}

// 4) Linkage integrity.
line("[4] Linkage integrity");
{
  const dangling = q1("SELECT COUNT(*) n FROM tool_calls WHERE spawned_session_id IS NOT NULL AND spawned_session_id NOT IN (SELECT id FROM sessions)").n;
  hard("every spawned_session_id resolves to a session", dangling === 0, `${dangling} dangling`);
  const badParentTurn = q1(
    "SELECT COUNT(*) n FROM sessions s WHERE s.parent_turn_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.id = s.parent_turn_id AND t.session_id = s.parent_session_id)",
  ).n;
  hard("linked subagent.parent_turn_id resolves within parent_session", badParentTurn === 0, `${badParentTurn} broken`);
}

// 5) Orphan accounting — report only (this is the workflow-subagent finding).
line("[5] Subagent linkage (report only)");
{
  const linked = q1("SELECT COUNT(*) n FROM sessions WHERE is_sidechain = 1 AND parent_session_id IS NOT NULL").n;
  const orphan = q1("SELECT COUNT(*) n FROM sessions WHERE is_sidechain = 1 AND parent_session_id IS NULL").n;
  const spawns = q1("SELECT COUNT(*) n FROM tool_calls WHERE tool_name IN ('Agent','Task')").n;
  soft("sidechain sessions", `${linked} linked, ${orphan} orphan (no parent_session_id)`);
  soft("Agent/Task spawns in transcripts", `${spawns}`);
  if (orphan > 0) soft("→ orphans are likely Workflow-tool agents linked via a journal, not a tool_use", "see docs/VALIDATION.md");
}

// 6) Aggregate recompute — materialized session aggregates must equal a fresh recount.
line("[6] Aggregate recompute");
{
  const badEvents = q1("SELECT COUNT(*) n FROM sessions s WHERE s.event_count != (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id)").n;
  hard("sessions.event_count == COUNT(events)", badEvents === 0, `${badEvents} mismatched`);
  const badTurns = q1("SELECT COUNT(*) n FROM sessions s WHERE s.turn_count != (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id)").n;
  hard("sessions.turn_count == COUNT(turns)", badTurns === 0, `${badTurns} mismatched`);
}

// 7) Turn attribution — assistant token rows should belong to a turn (report unattributed).
line("[7] Turn attribution (report only)");
{
  const nullTurn = q1("SELECT COUNT(*) n FROM token_usage WHERE turn_id IS NULL").n;
  soft("token_usage rows with NULL turn_id", `${nullTurn}`);
}

// 8) Unpriced models — any model carrying tokens but missing a rate distorts cost downward.
line("[8] Unpriced models (report only)");
{
  const models = qa("SELECT model, SUM(input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens) tok FROM token_usage GROUP BY model");
  const unpriced = models.filter((m) => m.tok > 0 && !rateForModel(m.model)).map((m) => `${m.model} (${fmt(m.tok)} tok)`);
  if (unpriced.length === 0) soft("all models with tokens are priced", "");
  else for (const u of unpriced) soft("UNPRICED", u);
}

line(`\n${hardFail === 0 ? "ALL HARD INVARIANTS PASS" : `${hardFail} HARD INVARIANT(S) FAILED`}\n`);
db.close();
process.exit(hardFail === 0 ? 0 : 1);
