/**
 * Canonical project roots (ADR-023) — canonicalizeProjects in canonicalize.ts. Git-root detection
 * runs against REAL temp directories (`.git` dirs/files created per test); the home guard uses the
 * injectable homeDir. Imports the BUILT dist.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "@agent-lens/core";
import { canonicalizeProjects } from "../dist/canonicalize.js";

let root: string; // fake $HOME for every test

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "al-canon-"));
  // $HOME/.git — the dotfiles-repo trap the home guard must ignore
  mkdirSync(join(root, ".git"), { recursive: true });
  // repo (git) with a subdir; nested repo inside a plain workspace; a worktree-style .git FILE
  mkdirSync(join(root, "repo", "packages", "lib"), { recursive: true });
  mkdirSync(join(root, "repo", ".git"), { recursive: true });
  mkdirSync(join(root, "ws", "inner", "src"), { recursive: true });
  mkdirSync(join(root, "ws", "inner", ".git"), { recursive: true });
  mkdirSync(join(root, "ws", ".local"), { recursive: true });
  mkdirSync(join(root, "wt", "sub"), { recursive: true });
  writeFileSync(join(root, "wt", ".git"), "gitdir: elsewhere\n"); // worktree marker file
  mkdirSync(join(root, "plainws", "evals"), { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.pragma("foreign_keys = OFF");
  return db;
}

let n = 0;
/** Seed a project row + one session in it; returns the project id. */
function addProject(db: Database.Database, path: string, opts: { sessions?: number; sidechain?: boolean } = {}): string {
  const pid = `p${n++}`;
  db.prepare("INSERT INTO projects (id, agent_id, path) VALUES (?, 'claude-code', ?)").run(pid, path);
  for (let i = 0; i < (opts.sessions ?? 1); i++) {
    db.prepare("INSERT INTO sessions (id, agent_id, project_id, is_sidechain, started_at) VALUES (?, 'claude-code', ?, ?, ?)").run(
      `s${n}-${i}`,
      pid,
      opts.sidechain ? 1 : 0,
      "2026-07-0" + ((i % 9) + 1) + "T00:00:00Z",
    );
  }
  return pid;
}

const paths = (db: Database.Database) =>
  (db.prepare("SELECT p.path FROM projects p ORDER BY p.path").all() as Array<{ path: string }>).map((r) => r.path);

describe("canonicalizeProjects", () => {
  it("folds a repo subdir into its git root (nearest .git wins, worktree .git file counts)", () => {
    const db = freshDb();
    addProject(db, join(root, "repo"));
    addProject(db, join(root, "repo", "packages", "lib"));
    addProject(db, join(root, "wt", "sub"));
    const r = canonicalizeProjects(db, { homeDir: root });
    expect(r.merged).toBe(2);
    expect(paths(db)).toEqual([join(root, "repo"), join(root, "wt")]);
  });

  it("mints the git-root row when only subdir sessions were ever observed", () => {
    const db = freshDb();
    addProject(db, join(root, "repo", "packages", "lib"));
    canonicalizeProjects(db, { homeDir: root });
    expect(paths(db)).toEqual([join(root, "repo")]);
  });

  it("keeps a nested git repo distinct from its non-git workspace, and folds the workspace's plain subdir into it", () => {
    const db = freshDb();
    addProject(db, join(root, "ws")); // plain workspace, itself observed
    addProject(db, join(root, "ws", "inner", "src")); // inside nested repo → inner
    addProject(db, join(root, "ws", ".local")); // plain subdir → ws (rule 2)
    const r = canonicalizeProjects(db, { homeDir: root });
    expect(r.merged).toBe(2);
    expect(paths(db)).toEqual([join(root, "ws"), join(root, "ws", "inner")]);
  });

  it("never folds into $HOME (dotfiles-repo guard) and keeps $HOME itself as-is", () => {
    const db = freshDb();
    addProject(db, root); // sessions run at $HOME stay there
    addProject(db, join(root, "plainws", "evals")); // no .git anywhere below home, no observed ancestor
    const r = canonicalizeProjects(db, { homeDir: root });
    expect(r.merged).toBe(0);
    expect(paths(db)).toEqual([root, join(root, "plainws", "evals")]);
  });

  it("keeps a DELETED human-opened project's identity — no ancestor folding for its mains", () => {
    const db = freshDb();
    addProject(db, join(root, "ws")); // live workspace, observed
    addProject(db, join(root, "ws", "deleted-repo"), { sessions: 10 }); // dir gone, has mains
    const r = canonicalizeProjects(db, { homeDir: root });
    expect(r.merged).toBe(0);
    expect(paths(db)).toEqual([join(root, "ws"), join(root, "ws", "deleted-repo")]);
  });

  it("folds a DELETED sidechain-only dir into its observed ancestor (spawn cwds, dead worktrees)", () => {
    const db = freshDb();
    addProject(db, join(root, "ws"), { sessions: 2 }); // ancestor itself deleted-or-not is irrelevant
    addProject(db, join(root, "ws", "evals"), { sessions: 5, sidechain: true }); // dir gone, no mains
    const r = canonicalizeProjects(db, { homeDir: root });
    expect(r.merged).toBe(1);
    expect(paths(db)).toEqual([join(root, "ws")]);
  });

  it("folds sidechain-only subdir projects (phantom dropdown entries) and repoints their sessions", () => {
    const db = freshDb();
    addProject(db, join(root, "plainws"), { sessions: 2 });
    addProject(db, join(root, "plainws", "evals"), { sessions: 3, sidechain: true });
    const r = canonicalizeProjects(db, { homeDir: root });
    expect(r.merged).toBe(1);
    expect(paths(db)).toEqual([join(root, "plainws")]);
    const count = (db.prepare("SELECT COUNT(*) c FROM sessions s JOIN projects p ON p.id = s.project_id WHERE p.path = ?").get(join(root, "plainws")) as any).c;
    expect(count).toBe(5);
  });

  it("deletes session-less orphan projects and repoints file_changes; is idempotent", () => {
    const db = freshDb();
    const sub = addProject(db, join(root, "repo", "packages", "lib"));
    addProject(db, join(root, "repo"));
    db.prepare("INSERT INTO projects (id, agent_id, path) VALUES ('orphan', 'claude-code', ?)").run(join(root, "ws"));
    db.prepare(
      "INSERT INTO file_changes (id, tool_call_id, session_id, project_id, file_path, tool_name) VALUES ('fc1', 'tc1', 's1-0', ?, ?, 'Edit')",
    ).run(sub, join(root, "repo", "x.ts"));

    const r1 = canonicalizeProjects(db, { homeDir: root });
    expect(r1.merged).toBe(1);
    expect(r1.removed).toBeGreaterThanOrEqual(2); // the folded source row + the orphan
    expect(paths(db)).toEqual([join(root, "repo")]);
    const fcProj = (db.prepare("SELECT p.path FROM file_changes fc JOIN projects p ON p.id = fc.project_id WHERE fc.id = 'fc1'").get() as any).path;
    expect(fcProj).toBe(join(root, "repo"));

    const before = db.prepare("SELECT * FROM projects ORDER BY id").all();
    const r2 = canonicalizeProjects(db, { homeDir: root });
    expect(r2).toEqual({ merged: 0, removed: 0 });
    expect(db.prepare("SELECT * FROM projects ORDER BY id").all()).toEqual(before);
  });

  it("refreshes the merged root's first/last_seen from its sessions", () => {
    const db = freshDb();
    addProject(db, join(root, "repo"), { sessions: 1 });
    addProject(db, join(root, "repo", "packages", "lib"), { sessions: 2 });
    canonicalizeProjects(db, { homeDir: root });
    const p = db.prepare("SELECT first_seen, last_seen FROM projects").get() as any;
    expect(p.first_seen).toBe("2026-07-01T00:00:00Z");
    expect(p.last_seen).toBe("2026-07-02T00:00:00Z");
  });
});
