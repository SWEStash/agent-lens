/**
 * Agent Lens — heuristic classification (ADR-004). No AI: category + complexity are derived
 * deterministically from signals already in the DB (tool mix, LoC from Edit/Write inputs,
 * turns, tokens, duration, subagent fan-out, prompt keywords). Re-runnable and idempotent —
 * the same DB always yields identical rows. Every input and sub-score is recorded in
 * `signals_json` so a result can be explained and the bands retuned without re-deriving meaning.
 *
 * Scope v1 = sessions (both main and sidechain). The PK (scope, target_id) leaves turn-level
 * for later. `classifier_version` lets a future (e.g. local-LLM) classifier supersede these rows.
 */
import type { DB } from "./db.js";

// v2 (ADR-004): realistic complexity ceilings so real (long, substantial) main sessions spread
// across bands instead of pegging in "large"; subagent sessions categorized by their spawner role
// rather than keyword heuristics on a read-only exploration transcript.
export const CLASSIFIER_VERSION = 2;

export type Category = "feature" | "bugfix" | "refactor" | "docs" | "ops" | "review" | "chore";

/** Fixed order = deterministic tie-break when scores are equal. */
const CATEGORIES: Category[] = ["bugfix", "refactor", "docs", "ops", "review", "feature", "chore"];

// Cutoffs tuned to the real main-session score distribution (v2 ceilings) so the five bands
// partition main work meaningfully (~9/19/32/32/8%). Subagents score low and land "trivial".
const BANDS: Array<{ max: number; band: string }> = [
  { max: 22, band: "trivial" },
  { max: 40, band: "small" },
  { max: 55, band: "medium" },
  { max: 68, band: "large" },
  { max: Infinity, band: "xl" },
];

/**
 * Subagent roles whose work is inherently investigative/planning ⇒ "review". A general-purpose (or
 * unknown) subagent does varied work, so fall back to the heuristic on its own transcript.
 */
const REVIEW_SUBAGENT_ROLES = new Set(["Explore", "Plan", "code-reviewer", "claude-code-guide"]);
function categoryForSubagentRole(role: string | undefined): Category | null {
  if (!role) return null;
  return REVIEW_SUBAGENT_ROLES.has(role) ? "review" : null;
}

/** Number of lines in a string (0 for empty/undefined). Trailing newline doesn't add a line. */
function countLines(s: string | undefined | null): number {
  if (!s) return 0;
  const trimmed = s.endsWith("\n") ? s.slice(0, -1) : s;
  return trimmed.length === 0 ? 0 : trimmed.split("\n").length;
}

const DOC_EXT = /\.(md|markdown|rst|txt|adoc)$/i;
const OPS_FILE = /(^|\/)(dockerfile|docker-compose|\.github\/|\.gitlab-ci|makefile)|\.(ya?ml|tf|sh|toml|ini|cfg|service|timer)$/i;

/** LoC contribution of a single Edit/Write tool call, parsed from its verbatim input_json. */
export function locDelta(toolName: string, inputJson: string | null): { added: number; removed: number; file: string | null } {
  if (!inputJson) return { added: 0, removed: 0, file: null };
  let input: any;
  try {
    input = JSON.parse(inputJson);
  } catch {
    return { added: 0, removed: 0, file: null };
  }
  const file = typeof input?.file_path === "string" ? input.file_path : null;
  if (toolName === "Write") return { added: countLines(input?.content), removed: 0, file };
  if (toolName === "Edit") return { added: countLines(input?.new_string), removed: countLines(input?.old_string), file };
  return { added: 0, removed: 0, file };
}

function band(score: number): string {
  for (const b of BANDS) if (score < b.max) return b.band;
  return "xl";
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

interface Signals {
  toolCounts: Record<string, number>;
  skills: Record<string, number>;
  loc: { added: number; removed: number; net: number; churn: number; files: number };
  turn_count: number;
  event_count: number;
  work_tokens: number; // input + output + cache_creation (cache-read excluded — replay ≠ work)
  cache_read_tokens: number;
  duration_ms: number;
  subagent_count: number;
  is_sidechain: number;
}

/** Count keyword hits (whole-word-ish) of any phrase in `words` within `text`. */
function hits(text: string, words: string[]): number {
  let n = 0;
  for (const w of words) {
    let i = text.indexOf(w);
    while (i !== -1) {
      n++;
      i = text.indexOf(w, i + w.length);
    }
  }
  return n;
}

function scoreCategories(s: Signals, text: string): Record<Category, number> {
  const t = text.toLowerCase();
  const editN = s.toolCounts["Edit"] ?? 0;
  const writeN = s.toolCounts["Write"] ?? 0;
  const readN = s.toolCounts["Read"] ?? 0;
  const writes = editN + writeN;

  const scores: Record<Category, number> = {
    bugfix: 0,
    refactor: 0,
    docs: 0,
    ops: 0,
    review: 0,
    feature: 0,
    chore: 0,
  };

  // Keyword evidence (prompt text).
  scores.bugfix += hits(t, ["bug", "fix", "broken", "crash", "regression", "traceback", "stack trace", "failing", "error", "exception", "not working"]) * 1.0;
  scores.refactor += hits(t, ["refactor", "clean up", "cleanup", "rename", "extract", "simplify", "dead code", "tidy", "reorganize", "restructure"]) * 1.0;
  scores.docs += hits(t, ["readme", "document", "documentation", "changelog", "docstring", "comment", "write docs", "usage guide"]) * 1.0;
  scores.ops += hits(t, ["deploy", "docker", "pipeline", "ci/cd", "ci ", "systemd", "infra", "kubernetes", "terraform", "release", "rollback", "container"]) * 1.0;
  scores.review += hits(t, ["review", "audit", "inspect", "look over", "feedback on"]) * 1.0;
  // "new " dropped — too noisy ("the new X", "new file"); "new feature" stays as a strong signal.
  scores.feature += hits(t, ["add ", "implement", "build ", "create ", "feature", "support for", "new feature"]) * 0.8;

  // Structural evidence (tools + files), scaled so it complements but doesn't drown keywords.
  const docFiles = s.loc.files > 0 ? countMatch(s, DOC_EXT) : 0;
  const opsFiles = s.loc.files > 0 ? countMatch(s, OPS_FILE) : 0;
  if (s.loc.files > 0) {
    scores.docs += 3 * (docFiles / s.loc.files);
    scores.ops += 3 * (opsFiles / s.loc.files);
  }
  // Edit-heavy + low net churn relative to gross churn ⇒ rework, not new code.
  if (writes >= 3 && s.loc.churn > 0 && Math.abs(s.loc.net) / s.loc.churn < 0.34) scores.refactor += 1.5;
  // Edit-dominated (lots of Edits, few/no new Writes) ⇒ reworking existing code, not adding it.
  if (editN >= 4 && editN >= writeN * 2) scores.refactor += 1.0;
  // Read-dominated, little writing ⇒ review/exploration.
  if (readN >= 5 && writes <= 2) scores.review += 1.5;
  // New files written with net-positive LoC ⇒ feature work.
  if (writeN >= 1 && s.loc.net > 20) scores.feature += 1.5;

  // No signal at all ⇒ record the default choice so the argmax (in classify) picks it.
  const maxScore = Math.max(...CATEGORIES.map((c) => scores[c]));
  if (maxScore === 0) scores[writes > 0 ? "feature" : "chore"] += 0.01;
  return scores;
}

/** Files matching a pattern is recomputed from the stored file list (kept on the signal object). */
function countMatch(s: Signals & { _files?: string[] }, re: RegExp): number {
  const files = s._files ?? [];
  let n = 0;
  for (const f of files) if (re.test(f)) n++;
  return n;
}

function complexity(s: Signals): { score: number; subscores: Record<string, number>; weights: Record<string, number> } {
  // v2 ceilings: tuned to the real p90 of substantial main sessions (churn ~2.6k, files ~29,
  // work-tokens in the tens of millions, multi-hour durations) so a median session sits mid-range
  // instead of pegging every subscore at 1.0. See ADR-004.
  const weights = { loc: 0.25, files: 0.15, turns: 0.2, tokens: 0.2, duration: 0.1, subagents: 0.1 };
  const subscores = {
    loc: clamp01(Math.log1p(s.loc.churn) / Math.log1p(6000)),
    files: clamp01(s.loc.files / 40),
    turns: clamp01(s.turn_count / 40),
    tokens: clamp01(Math.log1p(s.work_tokens) / Math.log1p(40_000_000)),
    duration: clamp01(s.duration_ms / (600 * 60_000)),
    subagents: clamp01(s.subagent_count / 10),
  };
  let acc = 0;
  for (const k of Object.keys(weights) as Array<keyof typeof weights>) acc += weights[k] * subscores[k];
  return { score: Math.round(acc * 1000) / 10, subscores, weights };
}

interface SessionAgg {
  id: string;
  is_sidechain: number;
  turn_count: number;
  event_count: number;
  duration_ms: number | null;
}

/**
 * (Re)classify every session into the `classifications` table. Returns the row count written.
 * One transaction; deterministic; safe to run repeatedly (ON CONFLICT upsert).
 */
export function classify(db: DB): { count: number; version: number } {
  const sessions = db
    .prepare("SELECT id, is_sidechain, turn_count, event_count, duration_ms FROM sessions")
    .all() as SessionAgg[];

  // Bulk-load per-session signals once, then assemble in JS (scales to many sessions).
  const toolMix = new Map<string, Record<string, number>>();
  for (const r of db.prepare("SELECT session_id, tool_name, COUNT(*) c FROM tool_calls GROUP BY session_id, tool_name").all() as any[]) {
    const m = toolMix.get(r.session_id) ?? {};
    m[r.tool_name] = r.c;
    toolMix.set(r.session_id, m);
  }
  const skillMix = new Map<string, Record<string, number>>();
  for (const r of db.prepare("SELECT session_id, skill_name, COUNT(*) c FROM tool_calls WHERE skill_name IS NOT NULL GROUP BY session_id, skill_name").all() as any[]) {
    const m = skillMix.get(r.session_id) ?? {};
    m[r.skill_name] = r.c;
    skillMix.set(r.session_id, m);
  }
  const tokens = new Map<string, { work: number; cacheRead: number }>();
  for (const r of db
    .prepare(
      `SELECT session_id, SUM(input_tokens) i, SUM(output_tokens) o,
              SUM(cache_creation_input_tokens) cw, SUM(cache_read_input_tokens) cr
       FROM token_usage GROUP BY session_id`,
    )
    .all() as any[]) {
    tokens.set(r.session_id, { work: (r.i ?? 0) + (r.o ?? 0) + (r.cw ?? 0), cacheRead: r.cr ?? 0 });
  }
  // LoC + files from Edit/Write inputs.
  const loc = new Map<string, { added: number; removed: number; files: Set<string> }>();
  for (const r of db.prepare("SELECT session_id, tool_name, input_json FROM tool_calls WHERE tool_name IN ('Edit','Write')").all() as any[]) {
    const d = locDelta(r.tool_name, r.input_json);
    const acc = loc.get(r.session_id) ?? { added: 0, removed: 0, files: new Set<string>() };
    acc.added += d.added;
    acc.removed += d.removed;
    if (d.file) acc.files.add(d.file);
    loc.set(r.session_id, acc);
  }
  // Prompt text for keyword signals.
  const promptText = new Map<string, string>();
  for (const r of db.prepare("SELECT session_id, prompt_preview FROM turns WHERE prompt_preview IS NOT NULL").all() as any[]) {
    promptText.set(r.session_id, (promptText.get(r.session_id) ?? "") + " " + r.prompt_preview);
  }
  // Subagent role from the spawning Task/Agent tool_call (schema-v3 linkage). Lets us categorize a
  // sidechain session by what it was spawned to do, rather than keyword-matching its transcript.
  const subagentRole = new Map<string, string>();
  for (const r of db
    .prepare(
      "SELECT s.id id, tc.agent_type role FROM sessions s JOIN tool_calls tc ON tc.spawned_session_id = s.id WHERE s.is_sidechain = 1 AND tc.agent_type IS NOT NULL",
    )
    .all() as any[]) {
    if (!subagentRole.has(r.id)) subagentRole.set(r.id, r.role);
  }

  const upsert = db.prepare(
    `INSERT INTO classifications (scope, target_id, category, complexity_score, complexity_band, signals_json, classifier_version)
     VALUES ('session', @target_id, @category, @complexity_score, @complexity_band, @signals_json, @classifier_version)
     ON CONFLICT(scope, target_id) DO UPDATE SET
       category=excluded.category, complexity_score=excluded.complexity_score,
       complexity_band=excluded.complexity_band, signals_json=excluded.signals_json,
       classifier_version=excluded.classifier_version`,
  );

  const tx = db.transaction(() => {
    for (const sess of sessions) {
      const toolCounts = toolMix.get(sess.id) ?? {};
      const skills = skillMix.get(sess.id) ?? {};
      const l = loc.get(sess.id) ?? { added: 0, removed: 0, files: new Set<string>() };
      const tok = tokens.get(sess.id) ?? { work: 0, cacheRead: 0 };
      const filesArr = [...l.files].sort();
      const subagentCount = (toolCounts["Agent"] ?? 0) + (toolCounts["Task"] ?? 0);

      const signals: Signals & { _files: string[] } = {
        toolCounts,
        skills,
        loc: { added: l.added, removed: l.removed, net: l.added - l.removed, churn: l.added + l.removed, files: l.files.size },
        turn_count: sess.turn_count,
        event_count: sess.event_count,
        work_tokens: tok.work,
        cache_read_tokens: tok.cacheRead,
        duration_ms: sess.duration_ms ?? 0,
        subagent_count: subagentCount,
        is_sidechain: sess.is_sidechain,
        _files: filesArr,
      };

      const catScores = scoreCategories(signals, promptText.get(sess.id) ?? "");
      let category: Category = "chore";
      let bestScore = -1;
      for (const c of CATEGORIES) {
        if (catScores[c] > bestScore) {
          bestScore = catScores[c];
          category = c;
        }
      }
      // For subagents, prefer the spawner's role (Explore/Plan/… ⇒ review) over keyword heuristics.
      const role = subagentRole.get(sess.id);
      if (sess.is_sidechain) {
        const roleCat = categoryForSubagentRole(role);
        if (roleCat) category = roleCat;
      }
      const cx = complexity(signals);

      // Deterministic, explainable signal blob (stable key order; _files dropped, exposed as loc.files).
      const signalsJson = JSON.stringify({
        tool_counts: toolCounts,
        skills,
        loc: signals.loc,
        files: filesArr,
        turn_count: signals.turn_count,
        event_count: signals.event_count,
        work_tokens: signals.work_tokens,
        cache_read_tokens: signals.cache_read_tokens,
        duration_ms: signals.duration_ms,
        subagent_count: signals.subagent_count,
        is_sidechain: signals.is_sidechain,
        subagent_role: role ?? null,
        category_scores: catScores,
        complexity_subscores: cx.subscores,
        complexity_weights: cx.weights,
        classifier_version: CLASSIFIER_VERSION,
      });

      upsert.run({
        target_id: sess.id,
        category,
        complexity_score: cx.score,
        complexity_band: band(cx.score),
        signals_json: signalsJson,
        classifier_version: CLASSIFIER_VERSION,
      });
    }
  });
  tx();

  return { count: sessions.length, version: CLASSIFIER_VERSION };
}
