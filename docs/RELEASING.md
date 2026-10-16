# Releasing

Agent Lens publishes one npm package, `@swestash/agent-lens` (from `packages/cli`; the command is
`agent-lens`). Releases are automated with [semantic-release](https://semantic-release.gitbook.io/)
from Conventional Commit messages. The reasoning is in
[ADR-016](decisions/ADR-016-npm-release-and-versioning.md).

## Versions come from commits

You never edit the version by hand. The next version is derived from the commits since the last tag:

| Commit | Example | Release |
|---|---|---|
| `fix:` | `fix(server): guard missing archive dir` | patch: `0.1.0` to `0.1.1` |
| `feat:` | `feat(cli): add metrics --json` | minor: `0.1.0` to `0.2.0` |
| `feat!:` or a `BREAKING CHANGE:` footer | `feat(cli)!: rename serve flag` | major: `0.1.0` to `1.0.0` |
| `docs:`, `chore:`, `refactor:`, `test:`, `ci:` | | none |

> [!IMPORTANT]
> On `0.x`, a breaking change still goes straight to `1.0.0`. Keep `!` and `BREAKING CHANGE` for a
> real break after publishing; land other breaking work as `feat:`.

## The PR title is the commit subject

`main` takes squash merges, so the PR title becomes the subject of the commit that lands, and that
subject is all semantic-release reads. A PR titled without a conventional prefix merges fine but
releases nothing. That's how `Copy a session's archive path, and one tooltip everywhere (#54)`
shipped without a `0.17.0`.

`.github/workflows/pr-title.yml` fails a PR whose title isn't conventional. If a release was still
missed, land an empty commit with the right subject through a PR:

```bash
git commit --allow-empty -m "feat(web): <what actually shipped>"
```

## What happens on merge

On every push to `main`, `.github/workflows/release.yml`:

1. **Gates the release** on `pnpm build`, the vitest suite, and `node scripts/smoke-tarball.mjs --global`,
   which installs the packed tarball globally the way a user would. That smoke test is the only
   check of the bundled CLI; the test suite runs per-package output.
2. **Releases** with `semantic-release` (`.releaserc.json`, `pkgRoot: packages/cli`): sets the
   version, publishes to npm with provenance, tags `vX.Y.Z`, and creates a GitHub Release with the
   notes. Nothing is committed back, so release notes live only on GitHub.

## One-time setup

Publishing is skipped, and the workflow stays green, until an `NPM_TOKEN` secret exists:

1. Create an npm **Automation** token for the `swestash` account at
   <https://www.npmjs.com/settings/swestash/tokens>, so 2FA doesn't block CI.
2. Add it to the repository:
   ```bash
   gh secret set NPM_TOKEN --repo SWEStash/agent-lens
   ```

`GITHUB_TOKEN` comes from Actions. Provenance uses `id-token: write` and `NPM_CONFIG_PROVENANCE=true`
([npm docs](https://docs.npmjs.com/generating-provenance-statements)).

## Dry runs

```bash
GITHUB_TOKEN=$(gh auth token) pnpm exec semantic-release --dry-run --no-ci   # the next version, without publishing
pnpm build && node scripts/smoke-tarball.mjs --global                       # the tarball installs and runs
```

## Before announcing a release

`smoke-tarball.mjs` proves the tarball installs. `scripts/sanity-e2e.sh` proves the published
package works on a real machine, end to end: install, systemd, collect, ingest, triage writes, and
the web UI.

```bash
scripts/sanity-e2e.sh                    # the latest published version
scripts/sanity-e2e.sh --version 0.13.0   # a specific version
scripts/sanity-e2e.sh --keep             # leave it running afterwards
```

It runs by hand, not in CI, because it needs a systemd user session and a Claude install with real
sessions. It's safe on a machine that already runs Agent Lens: it uses its own npm prefix, data
directory, port, and `agent-lens-sanity-*` units, checksums your units before and after, cleans up
on exit or abort, and fails if anything of yours changed. The browser checks need Playwright
(`pnpm install` at the repo root) and are skipped without it.

## Publishing by hand

Only to bootstrap or recover:

```bash
pnpm build                          # the CLI bundles the workspace packages
cd packages/cli && npm publish      # prepack rebuilds; access is public
git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
```

Keep the tag and the npm version in sync. semantic-release starts from the latest `vX.Y.Z` tag, so a
tag without a publish, or a publish without a tag, throws off later releases.

## No native dependencies

The package has no compiled dependencies ([ADR-029](decisions/ADR-029-node-sqlite-driver.md)):
SQLite is Node's built-in `node:sqlite`. Installing runs no scripts, downloads no binaries, and needs
no toolchain. The only platform requirement is `engines.node >= 24`.

One consequence: `packages/cli/tsup.config.ts` sets `removeNodeProtocol: false`. By default tsup
rewrites `node:foo` to `foo`, which breaks `node:sqlite` (it exists only with the prefix) with
`ERR_MODULE_NOT_FOUND` at startup. Only the global tarball smoke test catches that, so keep it.
