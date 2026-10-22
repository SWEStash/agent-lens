/**
 * Retention pruning (prune.ts). Only `<archive>/<label>/.versions/<TS>/` dirs may ever be deleted,
 * the dry run deletes nothing, and the run stamp in the dir name decides a snapshot's age.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pruneVersions, UserError } from "../dist/index.js";

const NOW = new Date(2026, 9, 22, 12, 0, 0);
let archive: string;

function snap(label: string, name: string, content = "x".repeat(100)): string {
  const dir = join(archive, label, ".versions", name);
  mkdirSync(join(dir, "projects"), { recursive: true });
  writeFileSync(join(dir, "projects", "a.jsonl"), content);
  return dir;
}

beforeEach(() => {
  archive = mkdtempSync(join(tmpdir(), "al-prune-"));
  mkdirSync(join(archive, "claude", "projects"), { recursive: true });
  writeFileSync(join(archive, "claude", "projects", "keep.jsonl"), "data");
});
afterEach(() => rmSync(archive, { recursive: true, force: true }));

describe("pruneVersions", () => {
  it("selects snapshots older than the window and deletes nothing on a dry run", () => {
    const old = snap("claude", "20260601T090000123"); // 143 days before NOW
    const fresh = snap("claude", "20261020T090000000");
    const r = pruneVersions({ archiveBase: archive, keepDays: 90, apply: false, now: NOW });
    expect(r.scanned).toBe(2);
    expect(r.candidates.map((c) => c.path)).toEqual([old]);
    expect(r.candidates[0]!.ageDays).toBe(143);
    expect(r.bytes).toBe(100);
    expect(existsSync(old) && existsSync(fresh)).toBe(true);
  });

  it("deletes only the selected snapshots with apply, across every source label", () => {
    const a = snap("claude", "20260101T000000000");
    const b = snap("claude-work", "20260102T000000000");
    const fresh = snap("claude", "20261021T000000000");
    pruneVersions({ archiveBase: archive, keepDays: 90, apply: true, now: NOW });
    expect(existsSync(a) || existsSync(b)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(join(archive, "claude", "projects", "keep.jsonl"))).toBe(true);
  });

  it("falls back to the dir's mtime when the name is not a run stamp", () => {
    const odd = snap("claude", "manual-copy");
    const t = (NOW.getTime() - 200 * 86_400_000) / 1000;
    utimesSync(odd, t, t);
    const r = pruneVersions({ archiveBase: archive, keepDays: 90, apply: false, now: NOW });
    expect(r.candidates.map((c) => c.ageDays)).toEqual([200]);
  });

  it("appends one line per run to .prune.log", () => {
    pruneVersions({ archiveBase: archive, keepDays: 30, apply: false, now: NOW });
    expect(readFileSync(join(archive, ".prune.log"), "utf8")).toMatch(/mode=dry-run keep_days=30 scanned=0 pruned=0 bytes=0\n$/);
  });

  it("rejects a bad window and a missing archive as user errors", () => {
    for (const keepDays of [-1, 1.5, NaN]) {
      expect(() => pruneVersions({ archiveBase: archive, keepDays, apply: false })).toThrow(UserError);
    }
    expect(() => pruneVersions({ archiveBase: join(archive, "nope"), keepDays: 90, apply: false })).toThrow(UserError);
  });
});
