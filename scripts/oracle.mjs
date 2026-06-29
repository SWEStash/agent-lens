#!/usr/bin/env node
/**
 * Redaction oracle (validation Layer 4) — ingest two transcript trees (RAW and REDACTED of the same
 * sessions) and assert their numeric/structural metric fingerprints are identical. This is the proof
 * that the committed corpus is metric-faithful to the real data it was derived from. The text-derived
 * classifier *category* is excluded (it is validated by golden fixtures, not the oracle).
 *
 *   node scripts/oracle.mjs --a <rawTreeRoot> --b <redactedTreeRoot>
 *
 * Each tree root is scanned recursively for *.jsonl; sessionId = filename stem (so agent-<id>.jsonl
 * subagent files link exactly as in production).
 */
import { dirname, join, basename } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";

const { openDb } = await import("../packages/ingest/dist/db.js");
const { prepareStatements, ingestFile, rebuildDerived, newStats } = await import("../packages/ingest/dist/pipeline.js");
const { classify } = await import("../packages/ingest/dist/classify.js");
const { ClaudeCodeAdapter } = await import("../packages/ingest/dist/adapters/claude-code.js");
const { costForUsage } = await import("../packages/core/dist/pricing.js");

const argv = process.argv.slice(2);
const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const aRoot = get("--a");
const bRoot = get("--b");
const ignore = get("--ignore"); // path substring to skip (e.g. the synthetic /scenarios/ source)
if (!aRoot || !bRoot) { console.error("usage: node scripts/oracle.mjs --a <rawRoot> --b <redactedRoot> [--ignore <substr>]"); process.exit(2); }

function listJsonl(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listJsonl(p));
    else if (e.isFile() && e.name.endsWith(".jsonl") && (!ignore || !p.includes(ignore))) out.push(p);
  }
  return out;
}

function ingestTree(root) {
  const db = openDb(":memory:");
  const stmts = prepareStatements(db);
  stmts.insAgent.run("claude-code", "Claude Code CLI");
  stmts.insSource.run({ id: "x", label: "x", agent_id: "claude-code", config_dir: null });
  const adapter = new ClaudeCodeAdapter();
  const stats = newStats();
  for (const file of listJsonl(root)) {
    const sessionId = basename(file, ".jsonl");
    const sf = { path: file, sessionId, encodedDir: basename(dirname(file)), isVersion: false, sourceId: "x" };
    const content = readFileSync(file, "utf8");
    ingestFile(db, stmts, adapter, sf, content.split("\n"), { size: statSync(file).size, mtimeMs: 0, hash: sessionId }, "2026-01-01T00:00:00.000Z", stats);
  }
  rebuildDerived(db);
  classify(db);
  return db;
}

/** Project/source-independent metric fingerprint. */
function fingerprint(db) {
  const one = (sql) => db.prepare(sql).get();
  const tok = one("SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(cache_creation_input_tokens),0) cw, COALESCE(SUM(cache_read_input_tokens),0) cr FROM token_usage");
  let cost = 0;
  for (const r of db.prepare("SELECT model, input_tokens i, output_tokens o, cache_creation_input_tokens cw, cache_read_input_tokens cr FROM token_usage").all())
    cost += costForUsage(r.model, { input_tokens: r.i, output_tokens: r.o, cache_creation_input_tokens: r.cw, cache_read_input_tokens: r.cr });
  return {
    sessions: one("SELECT COUNT(*) n FROM sessions").n,
    main: one("SELECT COUNT(*) n FROM sessions WHERE is_sidechain=0").n,
    subagent: one("SELECT COUNT(*) n FROM sessions WHERE is_sidechain=1").n,
    linked_subagents: one("SELECT COUNT(*) n FROM sessions WHERE is_sidechain=1 AND parent_session_id IS NOT NULL").n,
    turns: one("SELECT COUNT(*) n FROM turns").n,
    events: one("SELECT COUNT(*) n FROM events").n,
    tool_calls: one("SELECT COUNT(*) n FROM tool_calls").n,
    input: tok.i, output: tok.o, cache_creation: tok.cw, cache_read: tok.cr,
    cost: Number(cost.toFixed(6)),
    complexity_scores: db.prepare("SELECT complexity_score FROM classifications ORDER BY complexity_score").all().map((r) => r.complexity_score),
  };
}

const fa = fingerprint(ingestTree(aRoot));
const fb = fingerprint(ingestTree(bRoot));
const keys = Object.keys(fa);
let fails = 0;
console.log(`\nRedaction oracle — A(raw)=${aRoot}\n                   B(redacted)=${bRoot}\n`);
for (const k of keys) {
  const av = JSON.stringify(fa[k]);
  const bv = JSON.stringify(fb[k]);
  const ok = av === bv;
  if (!ok) fails++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${k}${ok ? `  = ${av}` : `  A=${av}  B=${bv}`}`);
}
console.log(`\n${fails === 0 ? "ORACLE PASS — redaction is metric-preserving" : `${fails} metric(s) DIVERGED`}\n`);
process.exit(fails === 0 ? 0 : 1);
