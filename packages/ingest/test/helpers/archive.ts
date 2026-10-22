/**
 * A throwaway archive + DB per test, for the tests that drive a real `runIngest` over files on disk.
 * Registers its own beforeEach/afterEach, so a test file calls it once at the top level and reads the
 * paths off the returned object inside each test.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, vi } from "vitest";
import { runIngest } from "../../dist/run.js";

export interface TestArchive {
  /** The temp dir holding everything below. */
  root: string;
  /** `<root>/archive`, the `--archive` passed to ingest. */
  archive: string;
  /** One project dir in the archive (`test/projects/-work-demo`), for a session's `.jsonl`. */
  projects: string;
  dbPath: string;
  /** `runIngest` against this archive and DB, plus any extra flags. */
  ingest: (...extra: string[]) => ReturnType<typeof runIngest>;
}

export function withArchive(prefix: string): TestArchive {
  const a = { ingest: (...extra: string[]) => runIngest(["--db", a.dbPath, "--archive", a.archive, ...extra]) } as TestArchive;
  beforeEach(() => {
    a.root = mkdtempSync(join(tmpdir(), prefix));
    a.archive = join(a.root, "archive");
    a.projects = join(a.archive, "test", "projects", "-work-demo");
    mkdirSync(a.projects, { recursive: true });
    a.dbPath = join(a.root, "test.db");
    vi.stubEnv("CLAUDE_DIR", join(a.root, "claude"));
    vi.stubEnv("AGENT_LENS_LABEL", "test");
  });
  afterEach(() => {
    rmSync(a.root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  return a;
}
