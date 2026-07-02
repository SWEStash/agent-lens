# ADR-016 — npm publishing + automated versioning (semantic-release)

- Status: Accepted
- Date: 2026-07-01
- Deciders: project owner
- Builds on [ADR-012](ADR-012-single-cli-distribution.md) (single bundled CLI) and the
  [ADR-014](ADR-014-unified-service-command.md) note that `packages/cli` was `private:true`, pre-1.0.

## Context

The `agent-lens` CLI (`packages/cli`) is the single publishable artifact (ADR-012): a tsup bundle of
the workspace code with only the native/framework runtime deps (`better-sqlite3`, `fastify`,
`@fastify/static`, `chokidar`) kept external so `npm install` resolves platform-correct binaries.
It was `private:true` / `0.0.0`, with a from-tarball smoke (`scripts/smoke-tarball.mjs`) but no
publish path. We want conventional-commit-driven releases gated by CI, and a first public version
that reflects the tool's maturity (**pre-1.0**), not `1.0.0`.

Two facts shaped the decision:

1. **semantic-release does not keep breaking changes as minor while on 0.x.** By default a
   `feat!` / `BREAKING CHANGE` commit bumps straight to `1.0.0` (`semver.inc('0.1.0','major')`
   is `1.0.0`). The pre-release history contains one such commit
   (`feat(cli)!: replace schedule with unified service command`). Letting semantic-release cut the
   first release would therefore produce `1.0.0`.
2. **better-sqlite3 12.11.1 ships Node-24 prebuilds** (`node-v137`) for linux glibc+musl, darwin, and
   win32 across x64/arm64 — full coverage for our `engines.node >=24`. It must stay **external** in
   the tsup bundle so npm resolves the right binary at install time.

## Decision

**Hand-cut the `0.1.0` baseline, let semantic-release govern every release after it.**

- `packages/cli` is published at **`0.1.0`** as the initial release (the pre-release history,
  including the breaking commit, *is* that baseline — nothing was published for it to break). A
  `v0.1.0` git tag marks the baseline commit so semantic-release never computes a from-scratch
  (→ `1.0.0`) release.
- **semantic-release** (`.releaserc.json`, run from the repo root with `pkgRoot: packages/cli`) then
  drives subsequent releases from conventional commits: `fix:` → patch, `feat:` → minor, and a future
  intentional `feat!` / `BREAKING CHANGE` → major (correct once there is a published API to break).
  Plugin chain: commit-analyzer → release-notes-generator → changelog → npm → git → github.
- **CI gate** (`.github/workflows/release.yml`, on push to `main`): `pnpm build` + `pnpm test` + a
  **real global-install** tarball smoke (`node scripts/smoke-tarball.mjs --global`, which does
  `npm install -g` so better-sqlite3's prebuild fetch is exercised) must pass before semantic-release
  publishes. The release step is guarded by `if: ${{ env.NPM_TOKEN != '' }}` so the workflow stays
  green until the `NPM_TOKEN` repo secret is configured. `ci.yml` runs the fast (network-free)
  tarball smoke on every PR.

### Packaging

`publishConfig.access: public`; `files` ships `dist`, `web`, `README.md`, `LICENSE`. A CLI-scoped
`README.md` (self-contained, absolute GitHub links) and a copied `LICENSE` were added — both were
listed in `files` but absent. `copy-web.mjs` now strips `web/snapshot/` (the static Pages demo
fixtures) from the packaged `web/`, since the runtime server serves the live API, never those files.

## Consequences

- First publish is a **watched, manual** `npm publish` of `0.1.0` (standard for a first-ever release);
  automation takes over from the next releasable commit. The `v0.1.0` tag and the published `0.1.0`
  must stay in sync — publishing `0.1.0` is required, not optional, or semantic-release will skip
  straight to `0.2.0`/`0.1.1` on npm.
- Honest semver: no polluting custom `releaseRules` (which would make *all* future breaking changes
  minor) and no git-history rewrite.
- Releases require an npm **automation token** as the `NPM_TOKEN` repo secret; publishes use npm
  **provenance** (`id-token: write` + `NPM_CONFIG_PROVENANCE`).
- **better-sqlite3 fallback:** if a platform/ABI has no prebuilt binary, `npm install` compiles it
  from source via node-gyp (needs a C++ toolchain + Python). Documented in the CLI README.

## Alternatives considered

- **Let semantic-release cut the first release.** Simplest mechanically, but the breaking commit
  forces `1.0.0` — contradicts the pre-1.0 intent.
- **Reword the unpushed `feat(cli)!` to a plain `feat`, seed `v0.0.0`, let semantic-release publish
  `0.1.0`.** Clean semver and fully automated, but rewrites already-made (unpushed) commits; rejected
  to preserve the authored history.
- **Custom `releaseRules` mapping breaking → minor.** Would keep 0.x semantics automatically, but the
  rule is unconditional and would wrongly demote real breaking changes post-1.0.
