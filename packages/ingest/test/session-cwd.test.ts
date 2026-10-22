/**
 * A session opened at a repo root that ended in a subdirectory used to be keyed on that subdirectory.
 * While the repo existed, canonicalization folded it back into the repo; once the repo was deleted, a
 * `--full` rebuild kept the subdirectory as its own project, and every edit at the repo root became
 * "outside the project". The archive still says where the session was opened, so that decides.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withArchive } from "./helpers/archive.js";

const a = withArchive("al-cwd.");



describe("session project after its directory is deleted", () => {
  it("is the directory the session was opened in", () => {
    const repo = join(a.root, "deleted-repo"); // never created: the repo is gone
    const dir = join(a.archive, "test", "projects", "-deleted-repo");
    mkdirSync(dir, { recursive: true });
    const line = (n: number, cwd: string) =>
      JSON.stringify({ type: "user", uuid: `u${n}`, sessionId: "s1", timestamp: `2026-01-01T00:00:0${n}.000Z`, cwd, message: { role: "user", content: `prompt ${n}` } }) + "\n";
    writeFileSync(join(dir, "s1.jsonl"), line(1, repo) + line(2, join(repo, "docs")) + line(3, join(repo, ".local", "plans")));

    a.ingest("--full");
    const db = new DatabaseSync(a.dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT p.path FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = 's1'").get() as { path: string };
      expect(row.path).toBe(repo);
    } finally {
      db.close();
    }
  });
});
