# Releasing

Agent Lens publishes a single npm package — **`@swestash/agent-lens`** (`packages/cli`; the installed
command is `agent-lens`) — with automated,
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
   of the packed tarball, resolving deps from the registry exactly as a user would). This is the
   only gate that exercises the tsup **bundle** rather than per-package `tsc` output; the test
   suite cannot see bundle-only breakage.
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

## Pre-announce sanity check

`smoke-tarball.mjs` proves the *tarball* is installable. Before announcing a release, prove the
*published* package works on a real machine end to end — install → systemd → collect → ingest →
store → triage writes → web UI:

```bash
scripts/sanity-e2e.sh                    # against the latest published version
scripts/sanity-e2e.sh --version 0.13.0   # or a specific one
scripts/sanity-e2e.sh --keep             # leave it running to poke at
```

This is a **manual gate, not a CI job**: it needs a live systemd user session and a real Claude
install with sessions in it, neither of which exists on a runner. It is safe to run on a machine
that already uses Agent Lens — it installs to an isolated npm prefix, data dir, and port, runs its
systemd units under `agent-lens-sanity-*` names, checksums your existing units before and after, and
tears everything down on exit (including on abort). It fails the run if anything of yours changed.

Requires Playwright for the browser sweep (`pnpm install` at the repo root); without it that one
phase is skipped with a notice and the rest still runs.

## Manual publish (fallback)

Automation is the norm; publish by hand only to bootstrap or recover:

```bash
pnpm -r build                       # workspace dist must exist — the CLI bundles @agent-lens/*
cd packages/cli && npm publish      # prepack rebuilds; publishConfig.access=public is set
git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
```

Keep the git tag and the npm version **in sync** — semantic-release uses the latest `vX.Y.Z` tag as
its baseline. A tag with no matching npm publish (or vice versa) will desync future automated bumps.

## No native dependencies

agent-lens ships **no compiled dependencies** ([ADR-029](decisions/ADR-029-node-sqlite-driver.md)).
SQLite is Node's built-in `node:sqlite`, so `npm install` runs no lifecycle scripts, fetches no
prebuilt binaries, and never needs a C++ toolchain. Nothing about the release is platform- or
Node-ABI-specific beyond the `engines.node >= 24` floor.

One bundling caveat this imposes: `packages/cli/tsup.config.ts` sets `removeNodeProtocol: false`.
tsup otherwise rewrites `node:foo` imports to bare `foo`, which is harmless for `fs`/`zlib`/`crypto`
but fatal for `node:sqlite` — it is prefix-only, so the stripped bundle dies on startup with
`ERR_MODULE_NOT_FOUND`. The per-package `tsc` output keeps the prefix, so **only** the global tarball
smoke catches a regression here. Do not remove that gate.
