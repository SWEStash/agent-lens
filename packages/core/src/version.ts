/**
 * Resolve the running build's version (ADR-027).
 *
 * There is no version recorded in the repository: `@semantic-release/git` was dropped in PR #6
 * because its `git push HEAD:main` is rejected by the `protect-main` ruleset, so the committed
 * manifests are permanent placeholders (`0.0.0`, `0.0.0-development`). The real version lives in a
 * different place depending on how the app was installed, so resolution is a chain that reports
 * which link answered — the same "say where the value came from" idiom `agent-lens config` uses for
 * paths (see ConfigOrigin in config.ts).
 *
 *   1. package.json, when it is NOT a 0.0.0* placeholder  → "npm"      (published tarball:
 *      @semantic-release/npm stamps the real version before packing)
 *   2. git describe --tags --always --dirty               → "git"      (a clone: a normal clone
 *      fetches tags, and the extra detail — v0.9.6-3-gabc1234 — is what you want from a dev build)
 *   3. neither available                                  → "unknown"
 *
 * "unknown" is reachable only from undocumented install paths (a shallow clone with no tags, or a
 * GitHub source zip, which has neither npm metadata nor .git). That is deliberate: reporting
 * "unknown" beats reporting the `0.0.0` placeholder as if it were real.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

export type VersionSource = "npm" | "git" | "unknown";

export interface ResolvedVersion {
  /** "0.9.6" (npm) · "v0.9.6-3-gabc1234-dirty" (git) · "unknown". Not necessarily semver — see source. */
  version: string;
  source: VersionSource;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** A committed manifest never carries a real version, only the release placeholders. */
function isPlaceholder(v: string): boolean {
  return v.startsWith("0.0.0");
}

/** Nearest package.json walking up from `dir`, or null. */
function nearestPackageVersion(dir: string): string | null {
  const { root } = parse(dir);
  for (let d = dir; ; d = dirname(d)) {
    try {
      const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf8")) as { version?: string };
      if (typeof pkg.version === "string" && pkg.version) return pkg.version;
    } catch {
      /* no package.json here (or unreadable) — keep walking */
    }
    if (d === root) return null;
  }
}

/**
 * `git describe` in `cwd`. Returns null when git is missing, this is not a work tree, or no tag is
 * reachable — all of which are normal, not errors. `--always` still yields a bare SHA when the only
 * problem is a missing tag (shallow clone), which is more useful than nothing.
 */
function gitDescribe(cwd: string): string | null {
  try {
    const r = spawnSync("git", ["describe", "--tags", "--always", "--dirty"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.status !== 0) return null;
    const out = r.stdout?.trim();
    return out ? out : null;
  } catch {
    return null; // git binary absent
  }
}

/** Uncached resolution — exported for tests, which need to drive each branch independently. */
export function computeVersion(fromDir: string = moduleDir): ResolvedVersion {
  const pkg = nearestPackageVersion(fromDir);
  if (pkg && !isPlaceholder(pkg)) return { version: pkg, source: "npm" };

  const described = gitDescribe(fromDir);
  if (described) return { version: described, source: "git" };

  return { version: "unknown", source: "unknown" };
}

let cached: ResolvedVersion | null = null;

/**
 * The running build's version, resolved once per process. Memoized because step 2 spawns `git`, and
 * this is read by /api/health, which the SPA polls — it must never spawn per request.
 */
export function resolveVersion(): ResolvedVersion {
  if (!cached) cached = computeVersion();
  return cached;
}

/** Test seam: drop the memo so a test can drive resolution against a different tree. */
export function resetVersionCache(): void {
  cached = null;
}
