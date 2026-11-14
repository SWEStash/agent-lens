/**
 * The read-only report commands (`sessions`, `findings`, `cost`). The pure helpers are tested
 * directly; the commands run as the BUILT binary over the committed corpus, ingested into a temp
 * store, so the table and --json output are what a user gets.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { formatTable, parseSince, shortId, startOfToday } from "../src/report.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const CLI = join(HERE, "..", "dist", "agent-lens.js");

describe("parseSince", () => {
  const now = new Date("2026-11-13T12:00:00.000Z");
  it("turns hours, days and weeks into an exact timestamp", () => {
    expect(parseSince("24h", now)).toBe("2026-11-12T12:00:00.000Z");
    expect(parseSince("7d", now)).toBe("2026-11-06T12:00:00.000Z");
    expect(parseSince("2w", now)).toBe("2026-10-30T12:00:00.000Z");
  });
  it("keeps a date as a date", () => {
    expect(parseSince("2026-11-01", now)).toBe("2026-11-01");
  });
  it("refuses anything else", () => {
    for (const bad of ["yesterday", "7", "7m", "2026-13-45", ""]) expect(() => parseSince(bad, now)).toThrow(/invalid --since/);
  });
});

describe("helpers", () => {
  it("startOfToday is local midnight", () => {
    const d = new Date(startOfToday(new Date(2026, 10, 13, 15, 30)));
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 10, 13, 0, 0]);
  });
  it("shortId keeps a subagent's prefix", () => {
    expect(shortId("0a1b2c3d-1111-4222-8333-444455556666")).toBe("0a1b2c3d");
    expect(shortId("agent-a1b2c3d4e5f60718")).toBe("agent-a1b2c3d4");
  });
  it("formatTable aligns columns and truncates the flex column to the width", () => {
    const rows = [{ a: "x", t: "a long title that will not fit", n: 5 }, { a: "yy", t: "short", n: 120 }];
    const out = formatTable(rows, [
      { header: "A", value: (r) => r.a },
      { header: "TITLE", value: (r) => r.t, flex: true },
      { header: "N", value: (r) => String(r.n), align: "right" },
    ], 20).split("\n");
    expect(out[0]).toBe("A   TITLE          N");
    expect(out[1]).toBe("x   a long tit…    5");
    expect(out[2]).toBe("yy  short        120");
    for (const l of out) expect(l.length).toBeLessThanOrEqual(20);
  });
});

describe("report commands over the corpus", () => {
  let dir: string;
  let db: string;
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args, "--db", db], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COLUMNS: "120" },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "al-report-"));
    db = join(dir, "store.db");
    const r = spawnSync(process.execPath, [CLI, "ingest", "--full", "--db", db, "--archive", join(REPO, "test/fixtures/corpus")], {
      encoding: "utf8",
      // AGENT_LENS_DATA keeps the run's lock file in the temp dir: in the default data dir it would
      // block a real collect, and the other CLI test running alongside.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        AGENT_LENS_CONFIG: join(REPO, "test/fixtures/corpus.sources.json"),
        AGENT_LENS_DATA: dir,
      },
    });
    expect(r.status, r.stderr).toBe(0);
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("sessions: --json is the API's SessionsPage, filtered like the web list", () => {
    const page = JSON.parse(run("sessions", "--json", "--pr", "https://github.com/demo/acme-api/pull/57").stdout);
    expect(page.total).toBe(2);
    expect(page.sessions.map((s: { id: string }) => s.id).sort()).toEqual(["sc-pr-links-0014", "sc-pr-links-0015"]);
    expect(page.sessions[0]).toHaveProperty("token_split");
  });

  it("sessions: a numeric --pr or --search is text, not a crash (cac parses numbers)", () => {
    const byNumber = run("sessions", "--json", "--pr", "57");
    expect(byNumber.status, byNumber.stderr).toBe(0);
    expect(JSON.parse(byNumber.stdout).total).toBe(2);
    expect(run("sessions", "--search", "404").status).toBe(0);
  });

  it("sessions: a table with a header row, and a note when rows are cut", () => {
    const { status, stdout } = run("sessions", "--limit", "3");
    expect(status).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^STARTED\s+SESSION\s+TITLE/);
    expect(lines).toHaveLength(5); // header, 3 rows, the "3 of N" note
    expect(lines[4]).toMatch(/^3 of \d+ sessions; raise --limit for more$/);
  });

  it("sessions: a project by its last path segment, and a clear error for an unknown one", () => {
    const page = JSON.parse(run("sessions", "--json", "--project", "acme-api", "--limit", "100").stdout);
    expect(page.total).toBeGreaterThan(0);
    expect(page.sessions.every((s: { project_path: string }) => s.project_path.endsWith("/acme-api"))).toBe(true);
    const bad = run("sessions", "--project", "no-such-project");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/no project 'no-such-project'/);
  });

  it("findings: open by default, filterable by severity, --json is FindingsPage", () => {
    const all = JSON.parse(run("findings", "--json", "--limit", "1000").stdout);
    const critical = JSON.parse(run("findings", "--json", "--severity", "critical", "--limit", "1000").stdout);
    expect(all.total).toBeGreaterThan(critical.total);
    expect(critical.total).toBeGreaterThan(0);
    expect(critical.findings.every((f: { severity: string }) => f.severity === "critical")).toBe(true);
    expect(run("findings", "--limit", "2").stdout).toMatch(/^SEVERITY\s+WHEN\s+SESSION\s+RULE\s+EVIDENCE/);
  });

  it("cost: all time matches the dashboard overview, and a future --since is empty", () => {
    const ov = JSON.parse(run("cost", "--json").stdout);
    expect(ov.cost).toBeGreaterThan(0);
    expect(run("cost").stdout).toContain(`Cost all time: $${ov.cost.toFixed(2)}`);
    const none = JSON.parse(run("cost", "--json", "--since", "2099-01-01").stdout);
    expect(none.sessions).toBe(0);
  });

  it("export takes a unique id prefix, and names the matches when it is ambiguous", () => {
    const md = run("export", "sc-appr"); // only sc-approvals-0013 starts with it
    expect(md.status, md.stderr).toBe(0);
    expect(md.stdout).toContain("sc-approvals-0013");
    const many = run("export", "sc-pr-links-");
    expect(many.status).toBe(1);
    expect(many.stderr).toMatch(/'sc-pr-links-' matches more than one session \(sc-pr-links-0014, sc-pr-links-0015\)/);
    expect(run("export", "zz-nothing").stderr).toMatch(/no session matches 'zz-nothing'/);
    expect(run("export", "sc_pr").stderr).toMatch(/no session matches 'sc_pr'/); // _ is literal, not a wildcard
  });

  it("refuses bad input in one line, and a missing store", () => {
    expect(run("cost", "--today", "--since", "7d").stderr).toMatch(/--today or --since, not both/);
    const r = spawnSync(process.execPath, [CLI, "sessions", "--db", join(dir, "missing.db")], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no store at .*missing\.db/);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });
});
