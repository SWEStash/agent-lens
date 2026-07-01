# ADR-012 — Single bundled `agent-lens` CLI for npm distribution

- Status: Accepted
- Date: 2026-07-01
- Deciders: project owner
- Extends: [ADR-006](ADR-006-stack.md) (implementation stack)

## Context

The original deployment path was *clone the repo → `pnpm install` → `pnpm -r build` → run shell
scripts / pnpm scripts*, tied to a Linux + systemd + rsync layout (ADR-002, ADR-006). That's fine for
development but not portable: it can't be installed like a normal tool, and three entrypoints hardcoded
a `resolve(dirname(import.meta.url), "../../..")` repo anchor plus a spawn of `scripts/sources.mjs`,
neither of which survives being installed under `node_modules`.

Every user already has Node (they run the Claude Code CLI), so a Node-native, installable CLI is the
natural distribution.

## Decision

Publish a **single public npm package `agent-lens`** (`packages/cli`) exposing one binary with
subcommands (`collect`, `ingest`, `serve`, `watch`, `metrics`, `schedule`). Keep the internal packages
(`core`, `ingest`, `server`, `web`) as private workspace packages.

- **Bundle with tsup/esbuild.** The pure-JS workspace code (`@agent-lens/*`) and the tiny `cac` parser
  are **inlined** into one `dist/agent-lens.js` — so their `workspace:*` versions never need publishing.
  Only the native / framework deps stay **external** runtime dependencies: `better-sqlite3` (native,
  ships prebuilt binaries), `fastify`, `@fastify/static`, `chokidar`.
- **Ship the web SPA** inside the package (`<pkg>/web`, copied at build/pack time); the server resolves
  it via `import.meta.url` (`resolveWebDist`), not a repo path.
- **Remove the repo-layout assumption.** Path/source resolution moved into `@agent-lens/core`
  (`findRepoRoot`, `resolveDataDir`, `resolveConfigFile`, `resolveWebDist`): run from the dev repo it
  uses `<repo>/data`; installed, it falls back to a per-user OS dir (`~/.local/share`, `Application
  Support`, `%LOCALAPPDATA%`). Ingest calls the resolver in-process instead of spawning `sources.mjs`.
- **Refactor for bundling.** `ingest`/`server` expose importable `run.ts` functions (`runIngest`,
  `runMetrics`, `startServer`) with thin auto-running bins, so the CLI bundles them without executing
  on import.

Install: `npm install -g agent-lens` (or `npx agent-lens <cmd>`).

## Consequences

- One cross-platform install; no clone/build for end users. The dev/from-source flow is unchanged.
- `better-sqlite3` must have a prebuilt binary for the user's Node ABI + platform (else it falls back to
  a node-gyp compile needing a toolchain) — verified per release. `npm i -g` is recommended over repeat
  `npx` so the native binary is cached once.
- A from-tarball smoke test (`scripts/smoke-tarball.mjs`) runs collect→ingest→serve from an extracted
  package with no repo present, guarding the "no repo-layout assumption" invariant.

## Alternatives considered

- **Publish scoped packages separately** (`@agent-lens/core`, `/ingest`, …). More library-idiomatic but
  higher release/versioning overhead for an end-user tool; rejected in favor of one binary.
- **Keep git-clone + pnpm as the only path.** Not portable; not installable; Linux-centric.
