/**
 * A session opened at a repo root that ended in a subdirectory used to be keyed on that subdirectory.
 * While the repo existed, canonicalization folded it back into the repo; once the repo was deleted, a
 * `--full` rebuild kept the subdirectory as its own project, and every edit at the repo root became
 * "outside the project". The archive still says where the session was opened, so that decides.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { runIngest } from "../dist/run.js";

let root: string;
const env = { CLAUDE_DIR: process.env.CLAUDE_DIR, AGENT_LENS_LABEL: process.env.AGENT_LENS_LABEL };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "al-cwd."));
  process.env.CLAUDE_DIR = join(root, "claude");
  process.env.AGENT_LENS_LABEL = "test";
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

describe("session project after its directory is deleted", () => {
  it("is the directory the session was opened in", () => {
    const repo = join(root, "deleted-repo"); // never created: the repo is gone
    const dir = join(root, "archive", "test", "projects", "-deleted-repo");
    mkdirSync(dir, { recursive: true });
    const line = (n: number, cwd: string) =>
      JSON.stringify({ type: "user", uuid: `u${n}`, sessionId: "s1", timestamp: `2026-01-01T00:00:0${n}.000Z`, cwd, message: { role: "user", content: `prompt ${n}` } }) + "\n";
    writeFileSync(join(dir, "s1.jsonl"), line(1, repo) + line(2, join(repo, "docs")) + line(3, join(repo, ".local", "plans")));

    const dbPath = join(root, "test.db");
    runIngest(["--db", dbPath, "--archive", join(root, "archive"), "--full"]);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT p.path FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = 's1'").get() as { path: string };
      expect(row.path).toBe(repo);
    } finally {
      db.close();
    }
  });
});
