# Releasing

Agent Lens publishes a single npm package — **`agent-lens`** (`packages/cli`) — with automated,
conventional-commit-driven releases via [semantic-release](https://semantic-release.gitbook.io/).
The rationale behind this setup is [ADR-016](decisions/ADR-016-npm-release-and-versioning.md);
this document is the how-to.

## How versioning works

**Every version bump is derived from the commit messages** since the last release tag — you never
edit the version by hand. Use [Conventional Commits](https://www.conventionalcommits.org/):

| Commit prefix | Example | Release |
|---|---|---|
| `fix:` | `fix(server): guard missing archive dir` | **patch** — `0.1.0 → 0.1.1` |
| `feat:` | `feat(cli): add metrics --json` | **minor** — `0.1.0 → 0.2.0` |
| `feat!:` / `BREAKING CHANGE:` footer | `feat(cli)!: rename serve flag` | **major** — `0.1.0 → 1.0.0` |
| `docs:` / `chore:` / `refactor:` / `test:` / `ci:` | — | **no release** |

> **Pre-1.0 note.** semantic-release does *not* treat breaking changes as minor while on `0.x` — a
> `feat!` / `BREAKING CHANGE` bumps straight to `1.0.0`. That is intentional: reserve `!` /
> `BREAKING CHANGE` for a genuine, post-publish API break. During `0.x`, land breaking-but-pre-stable
> work as plain `feat:` (minor). See ADR-016 for why `0.1.0` was hand-cut as the baseline.

## The automated flow

On every push to `main`, `.github/workflows/release.yml`:

1. **Gates** (nothing publishes unless all pass): `pnpm build`, `pnpm test`, and a real
   global-install tarball smoke — `node scripts/smoke-tarball.mjs --global` (does `npm install -g`
   of the packed tarball, so `better-sqlite3`'s prebuilt-binary fetch is exercised end to end).
2. **Releases** via `semantic-release` (config in `.releaserc.json`, run from the repo root with
   `pkgRoot: packages/cli`): computes the next version, updates `CHANGELOG.md` and
   `packages/cli/package.json`, publishes to npm (with provenance), creates the `vX.Y.Z` git tag,
   and opens a GitHub Release.

There is nothing to do to cut a release beyond **merging conventional commits to `main`**.

## One-time setup

The publish step is guarded by `if: ${{ env.NPM_TOKEN != '' }}`, so it is skipped (workflow stays
green) until the secret exists. To enable publishing:

1. Create an npm **Automation** token for the `swestash` account:
   <https://www.npmjs.com/settings/swestash/tokens> (type: *Automation*, so 2FA doesn't block CI).
2. Add it as a repository secret:
   ```bash
   gh secret set NPM_TOKEN --repo SWEStash/agent-lens   # paste the token when prompted
   ```

`GITHUB_TOKEN` is provided automatically by Actions. Publishes use npm
[provenance](https://docs.npmjs.com/generating-provenance-statements) (`id-token: write` +
`NPM_CONFIG_PROVENANCE=true`).

## Verifying / dry-running

```bash
# What would the next release be? (reads tags + commits; publishes nothing)
GITHUB_TOKEN=$(gh auth token) pnpm exec semantic-release --dry-run --no-ci

# Prove the published artifact works from a clean global install, no repo present:
pnpm -r build && node scripts/smoke-tarball.mjs --global
```

## Manual publish (fallback)

Automation is the norm; publish by hand only to bootstrap or recover:

```bash
pnpm -r build                       # workspace dist must exist — the CLI bundles @agent-lens/*
cd packages/cli && npm publish      # prepack rebuilds; publishConfig.access=public is set
git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
```

Keep the git tag and the npm version **in sync** — semantic-release uses the latest `vX.Y.Z` tag as
its baseline. A tag with no matching npm publish (or vice versa) will desync future automated bumps.

## Native dependency (`better-sqlite3`)

`better-sqlite3` is kept **external** in the tsup bundle (never inlined) so npm resolves the
platform-correct binary at install time. It ships prebuilt binaries for Node 24 (ABI `node-v137`)
across Linux (glibc + musl), macOS, and Windows on x64/arm64. If a platform/ABI has no prebuild,
`npm install` compiles it from source via node-gyp (requires a C++ toolchain + Python) — this is the
documented fallback, not an error.
