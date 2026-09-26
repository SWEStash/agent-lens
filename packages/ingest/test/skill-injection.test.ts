/**
 * Dynamic context injection in skill bodies. A SKILL.md line like !`git diff --staged --stat` is
 * run by Claude Code at load time and REPLACED by its output in the injected body — so the same
 * skill file renders differently on every firing. Versioning must hash the file, not the output
 * (otherwise every staged diff looks like a new version), and the output must not be stored (it is
 * the user's working-tree data). Empty output renders as the literal "(Bash completed with no
 * output)", which reveals where the slot sits; the same slot is then masked in firings where the
 * command did print something.
 */
import { describe, it, expect } from "vitest";
import type { SourceFile } from "@agent-lens/core";
import { openDb } from "../dist/db.js";
import { prepareStatements, ingestFile, rebuildDerived, newStats } from "../dist/pipeline.js";
import { ClaudeCodeAdapter } from "../dist/adapters/claude-code.js";
import { parseSkillInjection } from "../dist/pipeline.js";
import { learnSlots, maskDynamic, maskKnownValues, DYNAMIC_PLACEHOLDER } from "../dist/skillslots.js";

const EMPTY = "(Bash completed with no output)";
const render = (step1: string, pr: string) =>
  [
    "# Git Workflow",
    "",
    "### Step 1: Analyze the Changes",
    "",
    "Currently staged (live at skill load):",
    "",
    step1,
    "",
    "If the summary above is empty, run `git diff --staged`.",
    "",
    "### PR Step 1",
    "",
    "Branch state vs main:",
    "",
    pr,
    "",
    "If the output above is empty, run the equivalents.",
  ].join("\n");

const STAT = " docs/EVALS.md | 14 ++-\n evals/runner.mjs | 57 +++++++--\n 2 files changed, 60 insertions(+), 11 deletions(-)";
const LOG = `abc1234 feat: thing\n${EMPTY}`; // two adjacent injections: log printed, diff --stat empty
const ALL_EMPTY = render(EMPTY, `${EMPTY}\n\n${EMPTY}`);

describe("learnSlots / maskDynamic", () => {
  it("learns one slot per run of empty-output markers, anchored by the surrounding static lines", () => {
    expect(learnSlots(ALL_EMPTY)).toEqual([
      { before: "Currently staged (live at skill load):", after: "If the summary above is empty, run `git diff --staged`." },
      { before: "Branch state vs main:", after: "If the output above is empty, run the equivalents." },
    ]);
  });

  it("masks command output and empty markers to the same placeholder", () => {
    const slots = learnSlots(ALL_EMPTY);
    const masked = maskDynamic(render(STAT, LOG), slots);
    expect(masked).toBe(maskDynamic(ALL_EMPTY, slots));
    expect(masked).not.toContain("EVALS");
    expect(masked).not.toContain("abc1234");
    expect(masked).toContain(DYNAMIC_PLACEHOLDER);
  });

  it("learns slots back from an already-masked body (so stored versions keep teaching)", () => {
    const slots = learnSlots(ALL_EMPTY);
    expect(learnSlots(maskDynamic(ALL_EMPTY, slots))).toEqual(slots);
  });

  it("leaves a body without slots untouched, and does not mask when an anchor is ambiguous", () => {
    const plain = "# Demo\n\nNothing dynamic here.";
    expect(learnSlots(plain)).toEqual([]);
    expect(maskDynamic(plain, learnSlots(ALL_EMPTY))).toBe(plain);
    const dupAnchor = render(STAT, LOG) + "\n\nCurrently staged (live at skill load):\n\nstatic tail";
    const masked = maskDynamic(dupAnchor, learnSlots(ALL_EMPTY));
    expect(masked).toContain("EVALS"); // step-1 anchor is no longer unique → that slot is skipped
    expect(masked).not.toContain("abc1234"); // the PR slot is still unambiguous
  });
});

describe("harness argument formats", () => {
  const head = "Base directory for this skill: /home/x/.claude/skills/dataviz\n\n# Dataviz\n\nBody.";
  it("splits a trailing ARGUMENTS: block off the body", () => {
    expect(parseSkillInjection(`${head}\n\nARGUMENTS: make a chart`)).toMatchObject({ body: "# Dataviz\n\nBody.", args: "make a chart" });
  });
  it("splits a trailing ## User Request section off the body", () => {
    expect(parseSkillInjection(`${head}\n\n\n## User Request\n\nImprove the dashboard tiles.`)).toMatchObject({
      body: "# Dataviz\n\nBody.",
      args: "Improve the dashboard tiles.",
    });
  });
});

describe("maskKnownValues", () => {
  const known = { args: "fix the flaky login test", baseDir: "/home/x/.claude/skills/demo", sessionId: "11111111-2222-4333-8444-555555555555" };
  it("puts the template placeholders back where args, skill dir and session id were substituted", () => {
    const rendered = "Task: fix the flaky login test\nRun /home/x/.claude/skills/demo/scripts/check.sh\nLog to /tmp/11111111-2222-4333-8444-555555555555.log";
    expect(maskKnownValues(rendered, known)).toBe("Task: $ARGUMENTS\nRun ${CLAUDE_SKILL_DIR}/scripts/check.sh\nLog to /tmp/${CLAUDE_SESSION_ID}.log");
  });
  it("does not mask args too short to be told apart from ordinary words", () => {
    expect(maskKnownValues("go to step 2", { args: "go" })).toBe("go to step 2");
  });
});

// --- through the ingest pipeline ---------------------------------------------------------------

const SOURCE = "test";
const TS = (n: number) => `2026-01-03T00:${String(n).padStart(2, "0")}:00.000Z`;
const jsonl = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
const inject = (body: string) => `Base directory for this skill: /home/x/.claude/skills/git-workflow\n\n${body}\n\nARGUMENTS: go`;

function firingSession(sessionId: string, body: string, t0: number, args = "go", rawInject = inject(body)) {
  const content = jsonl(
    { uuid: `${sessionId}-0`, type: "user", timestamp: TS(t0), cwd: "/tmp/proj", message: { role: "user", content: "commit this" } },
    { uuid: `${sessionId}-1`, type: "assistant", timestamp: TS(t0 + 1), message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "tool_use", id: `tc-${sessionId}`, name: "Skill", input: { skill: "git-workflow", args } }], usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    { uuid: `${sessionId}-2`, type: "user", timestamp: TS(t0 + 2), isMeta: true, message: { role: "user", content: rawInject } },
  );
  const file: SourceFile = { path: `/fixtures/${sessionId}.jsonl`, sessionId, encodedDir: "-fixtures", isVersion: false, sourceId: SOURCE };
  return { file, content };
}

function setup() {
  const db = openDb(":memory:");
  const stmts = prepareStatements(db);
  stmts.insAgent.run("claude-code", "Claude Code CLI");
  stmts.insSource.run({ id: SOURCE, label: SOURCE, agent_id: "claude-code", config_dir: null });
  const adapter = new ClaudeCodeAdapter();
  const stats = newStats();
  const add = (f: ReturnType<typeof firingSession>) =>
    ingestFile(db, stmts, adapter, f.file, f.content.split("\n"), { size: f.content.length, mtimeMs: 0, hash: f.file.sessionId }, "2026-01-01T00:00:00.000Z", stats);
  return { db, add };
}

const DIRTY_OUTPUT = firingSession("s-dirty", render(STAT, LOG), 1);
const CLEAN = firingSession("s-clean", ALL_EMPTY, 10);

describe("skill versions ignore dynamic injection output", () => {
  it("full ingest: firings that differ only in command output share one version", () => {
    const { db, add } = setup();
    add(DIRTY_OUTPUT);
    add(CLEAN);
    rebuildDerived(db);
    const rows = db.prepare("SELECT id, body FROM skills WHERE name = 'git-workflow'").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].body).not.toContain("EVALS");
    expect(rows[0].body).not.toContain("abc1234");
    const ids = db.prepare("SELECT DISTINCT skill_id FROM tool_calls WHERE tool_name = 'Skill'").all() as any[];
    expect(ids).toEqual([{ skill_id: rows[0].id }]);
  });

  it("incremental: a later session that reveals the slot re-normalizes the earlier version", () => {
    const { db, add } = setup();
    add(DIRTY_OUTPUT);
    rebuildDerived(db, new Set(["s-dirty"]));
    add(CLEAN);
    rebuildDerived(db, new Set(["s-clean"]));
    const rows = db.prepare("SELECT id, body FROM skills WHERE name = 'git-workflow'").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].body).not.toContain("EVALS");
    const ids = db.prepare("SELECT DISTINCT skill_id FROM tool_calls WHERE tool_name = 'Skill'").all() as any[];
    expect(ids).toEqual([{ skill_id: rows[0].id }]);
  });
});

describe("skill versions ignore the user's arguments", () => {
  const base = "Base directory for this skill: /home/x/.claude/skills/git-workflow\n\n# Git Workflow\n\nDo it.";
  const versions = (...firings: Array<ReturnType<typeof firingSession>>) => {
    const { db, add } = setup();
    for (const f of firings) add(f);
    rebuildDerived(db);
    return db.prepare("SELECT body FROM skills WHERE name = 'git-workflow'").all() as Array<{ body: string }>;
  };

  it("a ## User Request section is not part of the version", () => {
    const req = (sid: string, t: number, a: string) => firingSession(sid, "", t, a, `${base}\n\n\n## User Request\n\n${a}`);
    const rows = versions(req("s-a", 1, "improve the stat tiles"), req("s-b", 10, "add dark mode support"));
    expect(rows.length).toBe(1);
    expect(rows[0].body).not.toContain("stat tiles");
  });

  it("args substituted inline ($ARGUMENTS) are masked back to the placeholder", () => {
    const inline = (sid: string, t: number, a: string) => firingSession(sid, "", t, a, `${base}\n\nThe task: ${a}\n\nEnd.`);
    const rows = versions(inline("s-a", 1, "improve the stat tiles"), inline("s-b", 10, "add dark mode support"));
    expect(rows.length).toBe(1);
    expect(rows[0].body).toContain("The task: $ARGUMENTS");
  });
});
