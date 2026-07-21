/**
 * Fixed data-layout paths (paths.ts). The archive and the triage sidecar are deliberately NOT
 * relocatable on their own (ADR-021): both hold data that cannot be reconstructed, so the only
 * supported way to move them is to move the whole data dir. These tests pin that contract —
 * in particular that AGENT_LENS_ARCHIVE / AGENT_LENS_TRIAGE_DB are no longer consulted.
 * Imports the BUILT dist so it exercises exactly what ships.
 */
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveArchiveDir, resolveDataDir, triageDbFor } from "../dist/index.js";

const KEYS = ["AGENT_LENS_ARCHIVE", "AGENT_LENS_TRIAGE_DB", "AGENT_LENS_DATA"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("resolveArchiveDir", () => {
  it("is always <dataDir>/archive", () => {
    expect(resolveArchiveDir()).toBe(join(resolveDataDir(), "archive"));
  });

  it("follows the data dir, which is the supported way to relocate it", () => {
    process.env.AGENT_LENS_DATA = "/srv/lens";
    expect(resolveArchiveDir()).toBe(join("/srv/lens", "archive"));
  });

  it("ignores AGENT_LENS_ARCHIVE — it desynced collect from ingest and is gone (ADR-021)", () => {
    process.env.AGENT_LENS_DATA = "/srv/lens";
    process.env.AGENT_LENS_ARCHIVE = "/somewhere/else";
    expect(resolveArchiveDir()).toBe(join("/srv/lens", "archive"));
  });
});

describe("triageDbFor", () => {
  it("sits beside the db it belongs to", () => {
    expect(triageDbFor("/srv/lens/agent-lens.db")).toBe("/srv/lens/triage.db");
  });

  it("ignores AGENT_LENS_TRIAGE_DB — the sidecar is not independently relocatable (ADR-021)", () => {
    process.env.AGENT_LENS_TRIAGE_DB = "/somewhere/else/triage.db";
    expect(triageDbFor("/srv/lens/agent-lens.db")).toBe("/srv/lens/triage.db");
  });
});
