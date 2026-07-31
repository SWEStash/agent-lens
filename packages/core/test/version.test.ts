/**
 * Runtime version resolution (version.ts, ADR-027). No version is committed to the repo — the
 * manifests are permanent 0.0.0* placeholders because @semantic-release/git was dropped in PR #6 —
 * so the resolver walks a chain and reports which link answered. These drive each link against a
 * real temp tree rather than mocking fs/git, since the whole point is behaviour against a real
 * install shape. Imports the BUILT dist so it exercises exactly what ships.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeVersion, resolveVersion } from "../dist/index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "al-version."));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const writePkg = (dir: string, version: string) =>
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version }));

describe("version: package.json (npm installs)", () => {
  it("a real version wins, and is labelled npm", () => {
    writePkg(root, "0.9.6");
    expect(computeVersion(root)).toEqual({ version: "0.9.6", source: "npm" });
  });

  it("finds the nearest package.json walking up from a nested dir", () => {
    writePkg(root, "1.2.3");
    const nested = join(root, "dist", "sub");
    mkdirSync(nested, { recursive: true });
    expect(computeVersion(nested).version).toBe("1.2.3");
  });

  it("both release placeholders are rejected, not reported as a version", () => {
    // The committed manifests: root package.json is 0.0.0, packages/cli is 0.0.0-development.
    // Treating either as real is the specific bug this chain exists to avoid.
    for (const placeholder of ["0.0.0", "0.0.0-development"]) {
      writePkg(root, placeholder);
      expect(computeVersion(root).version).not.toBe(placeholder);
      expect(computeVersion(root).source).not.toBe("npm");
    }
  });
});

describe("version: git describe (clones)", () => {
  const git = (cwd: string, ...args: string[]) =>
    spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

  /** A one-commit repo with a tag — the shape `git clone` of a released repo produces. */
  function initTaggedRepo(dir: string, tag: string): boolean {
    if (git(dir, "init", "-q").status !== 0) return false;
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "f.txt"), "hello");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    git(dir, "tag", tag);
    return true;
  }

  it("falls through a placeholder manifest to the tag, labelled git", () => {
    if (!initTaggedRepo(root, "v0.9.6")) return; // git unavailable — the resolver's own guard covers it
    writePkg(root, "0.0.0-development"); // placeholder present, as in a real clone
    const got = computeVersion(root);
    expect(got.source).toBe("git");
    expect(got.version).toMatch(/^v0\.9\.6/); // bare tag, or tag-N-gSHA once commits land on top
  });

  it("marks a dirty work tree", () => {
    if (!initTaggedRepo(root, "v1.0.0")) return;
    writeFileSync(join(root, "f.txt"), "changed"); // uncommitted
    expect(computeVersion(root).version).toContain("-dirty");
  });
});

describe("version: neither source available", () => {
  it("reports unknown rather than the placeholder", () => {
    // A GitHub source zip: placeholder manifest, no .git anywhere up the tree.
    writePkg(root, "0.0.0");
    const got = computeVersion(root);
    // Guard: only assert the no-git outcome when the temp dir really isn't inside a work tree.
    if (got.source === "git") return;
    expect(got).toEqual({ version: "unknown", source: "unknown" });
  });
});

describe("version: resolveVersion", () => {
  it("is memoized — repeated calls return the identical object", () => {
    // Identity, not equality: /api/health is polled, so this must not re-spawn git per call.
    expect(resolveVersion()).toBe(resolveVersion());
  });

  it("resolves this build to a non-empty version with a known source", () => {
    const got = resolveVersion();
    expect(got.version.length).toBeGreaterThan(0);
    expect(["npm", "git", "unknown"]).toContain(got.source);
  });
});
