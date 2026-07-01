/**
 * Stage 1 collector (collect.ts) — proves the rsync --append-verify port preserves semantics:
 * initial mirror, pure append, compaction (keep archive + snapshot source), divergence (snapshot old
 * archive + overwrite), secret exclusion, project exclusion, and the idempotent no-op skip. Plus the
 * single-instance lock. Imports the BUILT dist so it exercises exactly what ships.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectAll, encodeProjectPath, acquireLock, type Source } from "../dist/index.js";

let root: string;
let srcDir: string;
let archiveBase: string;

const ENC = encodeProjectPath("/home/u/proj"); // a real project path → projects/<enc>
const projFile = () => join(srcDir, "projects", ENC, "session.jsonl");

/** Write a file and stamp a deterministic mtime (epoch seconds) so skip/append/divergence are exact. */
function write(path: string, content: string, mtimeSec: number) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, mtimeSec, mtimeSec);
}

function collect(extra: Partial<Parameters<typeof collectAll>[0]> = {}) {
  const sources: Source[] = [{ label: "s1", agent: "claude-code", configDir: srcDir }];
  return collectAll({ archiveBase, sources, excludes: [], log: () => {}, ...extra });
}

const arc = (rel: string) => join(archiveBase, "s1", rel);
const arcProj = () => arc(`projects/${ENC}/session.jsonl`);
const versionsFor = (rel: string) =>
  readdirSync(join(archiveBase, "s1", ".versions"))
    .map((ts) => join(archiveBase, "s1", ".versions", ts, rel))
    .filter(existsSync);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "al-collect."));
  srcDir = join(root, "src");
  archiveBase = join(root, "archive");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("collectAll", () => {
  it("initial mirror copies whole files", () => {
    write(projFile(), "a\nb\n", 1000);
    write(join(srcDir, "history.jsonl"), "h\n", 1000);
    const stats = collect();
    expect(stats.copied).toBe(2);
    expect(readFileSync(arcProj(), "utf8")).toBe("a\nb\n");
    expect(readFileSync(arc("history.jsonl"), "utf8")).toBe("h\n");
  });

  it("pure append copies only the new tail", () => {
    write(projFile(), "a\nb\n", 1000);
    collect();
    write(projFile(), "a\nb\nc\n", 2000); // grew, same prefix
    const stats = collect();
    expect(stats.appended).toBe(1);
    expect(stats.copied).toBe(0);
    expect(readFileSync(arcProj(), "utf8")).toBe("a\nb\nc\n");
  });

  it("unchanged source is skipped (no snapshot, no rewrite)", () => {
    write(projFile(), "a\nb\n", 1000);
    collect();
    const stats = collect(); // nothing changed
    expect(stats.appended).toBe(0);
    expect(stats.copied).toBe(0);
    expect(stats.snapshots).toBe(0);
    expect(existsSync(join(archiveBase, "s1", ".versions"))).toBe(false);
  });

  it("divergence snapshots the old archive and overwrites", () => {
    write(projFile(), "AAAA", 1000);
    collect();
    write(projFile(), "BBBB", 2000); // same length, different content → prefix mismatch
    const stats = collect();
    expect(stats.diverged).toBe(1);
    expect(readFileSync(arcProj(), "utf8")).toBe("BBBB"); // archive overwritten with source
    const snaps = versionsFor(`projects/${ENC}/session.jsonl`);
    expect(snaps).toHaveLength(1);
    expect(readFileSync(snaps[0]!, "utf8")).toBe("AAAA"); // old archive preserved
  });

  it("compaction keeps the longer archive and snapshots the shorter source", () => {
    write(projFile(), "a\nb\nc\nd\n", 1000);
    collect();
    write(projFile(), "a\nb\n", 2000); // shorter → compaction
    const stats = collect();
    expect(stats.compacted).toBe(1);
    expect(readFileSync(arcProj(), "utf8")).toBe("a\nb\nc\nd\n"); // archive NOT shrunk
    const snaps = versionsFor(`projects/${ENC}/session.jsonl`);
    expect(readFileSync(snaps[0]!, "utf8")).toBe("a\nb\n"); // compacted source captured
  });

  it("never copies secrets and removes stray .credentials.json", () => {
    write(projFile(), "a\n", 1000);
    write(join(srcDir, "projects", ENC, "x.lock"), "lock", 1000);
    write(join(srcDir, ".credentials.json"), "SECRET", 1000);
    collect();
    // Pre-seed a stray credential into the archive to prove the post-pass sweep removes it.
    write(join(archiveBase, "s1", "projects", ENC, ".credentials.json"), "LEAK", 1000);
    collect();
    expect(existsSync(join(archiveBase, "s1", "projects", ENC, ".credentials.json"))).toBe(false);
    expect(existsSync(arc(`projects/${ENC}/x.lock`))).toBe(false);
  });

  it("excluded projects are not mirrored", () => {
    write(projFile(), "a\n", 1000);
    const stats = collect({ excludes: ["/home/u/proj"] });
    expect(stats.scanned).toBe(0);
    expect(existsSync(arcProj())).toBe(false);
  });

  it("throws when no sources are configured", () => {
    expect(() => collectAll({ archiveBase, sources: [], excludes: [], log: () => {} })).toThrow(/no sources/);
  });
});

describe("acquireLock", () => {
  it("blocks a second acquire while held, then allows it after release", () => {
    const lockPath = join(root, "lock.json");
    const a = acquireLock(lockPath);
    expect(a).not.toBeNull();
    expect(acquireLock(lockPath)).toBeNull(); // held by this live process
    a!.release();
    const b = acquireLock(lockPath);
    expect(b).not.toBeNull();
    b!.release();
  });

  it("reclaims a stale lock (old timestamp)", () => {
    const lockPath = join(root, "lock2.json");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: 1 })); // ancient
    const a = acquireLock(lockPath, 1000);
    expect(a).not.toBeNull();
    a!.release();
  });
});
