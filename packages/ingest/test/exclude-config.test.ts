/**
 * The config file's `exclude` list is honored by ingest and by the corpus redactor, not only the
 * AGENT_LENS_EXCLUDE env var. Paths are carried as a list end to end, so one containing a comma is
 * still one path (the env var is CSV, so a comma path can only come from the config file).
 *
 * Imports the BUILT dist.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { encodeProjectPath } from "@agent-lens/core";
import { runIngest } from "../dist/run.js";

const REDACT_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "redact-cli.js");
const KEEP = "/work/keep";
const DROP = "/work/a,b"; // a comma inside one path

let root: string;
const saved = { ...process.env };

function session(projectsDir: string, cwd: string, id: string): string {
  const dir = join(projectsDir, encodeProjectPath(cwd));
  mkdirSync(dir, { recursive: true });
  const line = { type: "user", uuid: `${id}-u1`, sessionId: id, timestamp: "2026-01-01T00:00:00.000Z", cwd, message: { role: "user", content: "hello" } };
  writeFileSync(join(dir, `${id}.jsonl`), JSON.stringify(line) + "\n");
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "al-exclude-cfg."));
  for (const k of ["CLAUDE_DIR", "AGENT_LENS_EXCLUDE", "AGENT_LENS_DATA"]) delete process.env[k];
  process.env.AGENT_LENS_DATA = join(root, "data");
  process.env.AGENT_LENS_CONFIG = join(root, "config.json");
  writeFileSync(
    process.env.AGENT_LENS_CONFIG,
    JSON.stringify({ sources: [{ label: "t", agent: "claude-code", configDir: join(root, "claude") }], exclude: [DROP] }),
  );
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  process.env = { ...saved };
});

describe("config exclude list", () => {
  it("keeps an excluded project whose path contains a comma out of the store", () => {
    const projects = join(root, "archive", "t", "projects");
    session(projects, KEEP, "s-keep");
    session(projects, DROP, "s-drop");
    const dbPath = join(root, "test.db");
    runIngest(["--db", dbPath, "--archive", join(root, "archive")]);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(db.prepare("SELECT id FROM sessions ORDER BY id").all()).toEqual([{ id: "s-keep" }]);
    } finally {
      db.close();
    }
  });

  it("is honored by the corpus redactor, not only AGENT_LENS_EXCLUDE", () => {
    const projects = join(root, "claude", "projects");
    const keep = session(projects, KEEP, "s-keep");
    const drop = session(projects, DROP, "s-drop");
    const out = join(root, "corpus");
    const r = spawnSync(process.execPath, [REDACT_CLI, "--out", out, "--label", "t", keep, drop], { env: process.env, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain(`skipped (excluded): ${drop}`);
    expect(existsSync(out)).toBe(true);
    expect(readdirSync(join(out, "t", "projects"))).toHaveLength(1);
  });
});
