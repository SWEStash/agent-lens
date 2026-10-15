/**
 * Deterministic synthetic corpus for performance work: the bench (scripts/bench.mjs) and the
 * query-plan guard (packages/server/test/query-plans.test.ts) both build their DB here.
 *
 * Volumes per session follow the real corpus ratios as of 2026-10 (17.9k sessions → 23.7k turns,
 * 512k events, 110k tool calls, 104k usage rows, 18k file changes, 2.7k findings; ~90% of sessions
 * are subagents). Row WIDTH matters as much as row count: the events and tool_calls tables average
 * ~3.4 KB and ~2.3 KB a row, so roughly one row fits per page, and any query that touches those rows
 * instead of an index reads the whole table. `raw_json` and `input_json` are padded with
 * incompressible filler for that reason. Shrink it with `rowBytes` for a fast functional DB.
 *
 * Same seed, same DB: the PRNG is seeded, and timestamps derive from a fixed epoch.
 */
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { SCHEMA_SQL } from "../../packages/core/dist/schema.js";

/** mulberry32 — a small seeded PRNG; Math.random would make every run a different corpus. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODELS = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-fable-5"];
const TOOLS = ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "Skill", "Agent", "ExitPlanMode", "AskUserQuestion", "TodoWrite"];
const TOOL_WEIGHTS = [30, 25, 14, 4, 8, 5, 3, 3, 1, 1, 6];
const ERROR_TYPES = ["user-rejected", "file-not-found", "command-failed", "other"];
const SEVERITIES = ["info", "low", "medium", "high", "critical"];
const EPOCH = Date.parse("2026-05-01T00:00:00Z");
const DAY = 86_400_000;

/**
 * Build a synthetic DB at `file` (":memory:" works).
 * @param {{ file?: string, sessions?: number, days?: number, seed?: number, rowBytes?: number }} opts
 * @returns {DatabaseSync} the open, writable connection
 */
export function buildSynthCorpus(opts = {}) {
  const { file = ":memory:", sessions = 1000, days = 150, seed = 42, rowBytes = 2400 } = opts;
  const rnd = prng(seed);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const weighted = (xs, ws) => {
    const total = ws.reduce((a, b) => a + b, 0);
    let r = rnd() * total;
    for (let i = 0; i < xs.length; i++) if ((r -= ws[i]) < 0) return xs[i];
    return xs[xs.length - 1];
  };
  // One filler buffer sliced at varying offsets: random bytes defeat page-level compression and cost
  // nothing to generate per row.
  const filler = randomBytes(rowBytes * 2 + 1);
  const pad = (n) => filler.subarray(Math.floor(rnd() * rowBytes), Math.floor(rnd() * rowBytes) + n);

  const db = new DatabaseSync(file);
  db.exec(SCHEMA_SQL);
  db.exec("PRAGMA foreign_keys = OFF; PRAGMA synchronous = OFF");
  db.exec("INSERT INTO agents (id, name, kind) VALUES ('claude-code', 'Claude Code CLI', 'cli')");
  for (const s of ["personal", "work"]) db.prepare("INSERT INTO sources (id, label, agent_id) VALUES (?, ?, 'claude-code')").run(s, s);
  for (let p = 0; p < 40; p++)
    db.prepare("INSERT INTO projects (id, agent_id, path) VALUES (?, 'claude-code', ?)").run(`p${p}`, `/home/u/proj${p}`);
  for (let k = 0; k < 30; k++)
    db.prepare("INSERT INTO skills (id, name, body, summary, last_seen) VALUES (?, ?, 'body', 'summary', '2026-09-01T00:00:00Z')").run(
      `sk${k}`,
      `skill-${k % 12}`,
    );

  const ins = {
    session: db.prepare(
      `INSERT INTO sessions (id, agent_id, source_id, project_id, is_sidechain, parent_session_id, started_at, ended_at,
                             duration_ms, event_count, turn_count)
       VALUES (?, 'claude-code', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    turn: db.prepare("INSERT INTO turns (id, session_id, seq, model, started_at, ended_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    event: db.prepare(
      `INSERT INTO events (uuid, session_id, turn_id, seq, type, role, timestamp, model, is_sidechain, text, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    usage: db.prepare(
      `INSERT INTO token_usage (event_uuid, session_id, turn_id, message_id, model, input_tokens, output_tokens,
                                cache_creation_input_tokens, cache_read_input_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    tool: db.prepare(
      `INSERT INTO tool_calls (id, event_uuid, session_id, turn_id, tool_name, skill_name, skill_id, agent_type, status,
                               error_type, input_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    change: db.prepare(
      `INSERT INTO file_changes (id, tool_call_id, session_id, turn_id, event_uuid, project_id, file_path, tool_name,
                                 lines_added, lines_removed, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    finding: db.prepare(
      `INSERT INTO findings (id, session_id, tool_call_id, event_uuid, rule_id, category, severity)
       VALUES (?, ?, ?, ?, 'destructive.rm_rf', 'destructive', ?)`,
    ),
    cls: db.prepare(
      "INSERT INTO classifications (scope, target_id, category, complexity_band) VALUES ('session', ?, ?, ?)",
    ),
    workflow: db.prepare(
      "INSERT INTO workflow_results (run_id, source_id, status, total_tokens, duration_ms, started_at) VALUES (?, ?, ?, ?, ?, ?)",
    ),
  };

  db.exec("BEGIN");
  let lastMain = null;
  for (let i = 0; i < sessions; i++) {
    const sid = `s${i}`;
    const sub = lastMain != null && rnd() < 0.9;
    const source = rnd() < 0.4 ? "personal" : "work";
    const start = EPOCH + Math.floor(rnd() * days * DAY);
    const model = pick(MODELS);
    // ~1.3 turns per session on average, ~29 events per session: the real corpus's shape.
    const turnCount = sub ? 1 : 1 + Math.floor(rnd() * 3);
    let t = start;
    let ev = 0;
    for (let k = 0; k < turnCount; k++) {
      const tid = `${sid}:${k}`;
      const turnStart = t;
      const nEvents = 14 + Math.floor(rnd() * 16);
      for (let e = 0; e < nEvents; e++) {
        t += 500 + Math.floor(rnd() * 20_000);
        const uuid = `${sid}-e${ev}`;
        const assistant = e % 2 === 1;
        ins.event.run(
          uuid, sid, tid, ev, assistant ? "assistant" : "user", assistant ? "assistant" : "user",
          new Date(t).toISOString(), assistant ? model : null, sub ? 1 : 0, "lorem ipsum dolor sit amet ".repeat(4), pad(rowBytes),
        );
        if (assistant && rnd() < 0.42)
          ins.usage.run(uuid, sid, tid, `msg_${uuid}`, model, 50 + Math.floor(rnd() * 5000), 20 + Math.floor(rnd() * 3000),
            Math.floor(rnd() * 20_000), Math.floor(rnd() * 200_000));
        if (assistant && rnd() < 0.45) {
          const tool = weighted(TOOLS, TOOL_WEIGHTS);
          const tcId = `${uuid}-tc`;
          const failed = rnd() < 0.08;
          const skill = tool === "Skill" ? Math.floor(rnd() * 30) : null;
          ins.tool.run(
            tcId, uuid, sid, tid, tool, skill == null ? null : `skill-${skill % 12}`, skill == null ? null : `sk${skill}`,
            tool === "Agent" ? pick(["Explore", "general-purpose", "Plan"]) : null,
            failed ? "error" : null, failed ? pick(ERROR_TYPES) : null, pad(Math.floor(rowBytes * 0.9)).toString("base64"),
          );
          if ((tool === "Edit" || tool === "Write") && !failed)
            ins.change.run(`${tcId}-fc`, tcId, sid, tid, uuid, `p${i % 40}`, `/home/u/proj${i % 40}/f${Math.floor(rnd() * 25)}.ts`,
              tool, Math.floor(rnd() * 40), Math.floor(rnd() * 20), new Date(t).toISOString());
          if (tool === "Bash" && rnd() < 0.08) ins.finding.run(`${tcId}-f`, sid, tcId, uuid, pick(SEVERITIES));
        }
        ev++;
      }
      ins.turn.run(tid, sid, k, model, new Date(turnStart).toISOString(), new Date(t).toISOString(), t - turnStart);
      t += 2_000 + Math.floor(rnd() * 600_000);
    }
    ins.session.run(sid, source, `p${i % 40}`, sub ? 1 : 0, sub ? lastMain : null, new Date(start).toISOString(),
      new Date(t).toISOString(), t - start, ev, turnCount);
    ins.cls.run(sid, pick(["feature", "bugfix", "refactor", "docs", "review"]), pick(["trivial", "small", "medium", "large"]));
    if (!sub) lastMain = sid;
    if (!sub && rnd() < 0.05)
      ins.workflow.run(`wf_${i}`, source, pick(["completed", "completed", "failed", "running"]), Math.floor(rnd() * 1e6), Math.floor(rnd() * 6e5),
        new Date(start).toISOString());
  }
  db.exec("COMMIT");
  return db;
}
