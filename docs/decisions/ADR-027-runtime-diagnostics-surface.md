# ADR-027 — A read-only diagnostics surface, and how the app learns its own version

- Status: Accepted
- Date: 2026-07-30
- Deciders: project owner

## Context

There is no way to tell, from the UI, which build of Agent Lens you are running. That matters more
here than in a hosted app: this is a long-lived local service installed by
`agent-lens service install`, so a machine can easily be serving a months-old build while the
operator reads current docs. The same question extends to the data — which schema, which detector,
which classifier produced what you are looking at.

The CLI already answers most of the *configuration* half. `agent-lens config`
(`packages/cli/src/index.ts:152`) prints the config file, data dir, archive, db, triage db, host,
port, non-local bind, retention and sources — each tagged with **where the value came from**
(`[env]`, `[default]`, `[fixed]`) under the stated precedence `flag > env > config file > default`.

Two problems block simply surfacing that in the browser.

**The app does not reliably know its own version, and cannot be made to hold it in a file.**
`@semantic-release/git` used to commit the version bump back, but it does `git push HEAD:main`, which
the `protect-main` ruleset rejects (PR required + required `build-test` check). That broke the
release job, so PR #6 dropped the plugin; semantic-release core still pushes `refs/tags/*` itself, so
tagging and GitHub Releases are unaffected. Restoring it would mean weakening branch protection or
granting the release bot a bypass — a real cost to fix a cosmetic one.

The consequence is that the committed manifests are permanent placeholders — root `package.json` is
`0.0.0`, `packages/cli` is `0.0.0-development` — and the real version lives in **two different places
depending on how the app was installed**: a git tag for a clone, and the published tarball's
`package.json` (stamped by `@semantic-release/npm` before packing) for an npm install. PR #6 already
relies on the second half: `agent-lens --version` reads package.json at runtime
(`packages/cli/src/index.ts:29`), which is why published builds report correctly today.

Compounding it, `release.yml` runs `pnpm build` (step 57) **before** `semantic-release` (step 80), so
anything stamped into the bundle at build time would bake in the placeholder.

**The config data cannot be published.** `scripts/export-snapshot.mjs` writes a static API snapshot
to a public GitHub Pages demo. Absolute filesystem paths (`/home/<user>/…`) must never enter it.

## Decision

### 1. Resolve the version at runtime, through a chain that reports its own source

No build-time stamping. Resolve once at server start, memoize for the process lifetime, and carry the
**provenance** alongside the string — the same idiom `agent-lens config` already uses for paths:

| Order | Source | Yields | When it wins |
|---|---|---|---|
| 1 | `packages/cli/package.json` version, when it is **not** a `0.0.0*` placeholder | `0.9.6` · `npm` | installed from npm — `@semantic-release/npm` writes the real version before packing |
| 2 | `git describe --tags --always --dirty` | `v0.9.6-3-gabc1234` · `git` | run from a clone |
| 3 | — | `unknown` | neither available |

The `0.0.0-development` placeholder is load-bearing: it is a reliable sentinel for "not a published
build", which is exactly what makes step 1 safe to trust when it *isn't* present.

The UI shows the provenance (`v0.9.6 (npm)`, `v0.9.6-3-gabc1234 (git)`). A dev build therefore says
so, instead of claiming `0.0.0` or silently reporting the last release.

**This resolves both documented install paths and no others.** README documents exactly two:
`npm install -g` / `npx` (step 1) and `git clone` (step 2 — a normal clone fetches tags, so
`git describe` works). Two undocumented paths degrade to `unknown`: a shallow clone that fetched no
tags, and a GitHub "Source code.zip", which carries neither npm metadata nor `.git`. That is
accepted: `unknown` is honest, and it is strictly better than the `0.0.0` those paths would report
from the placeholder.

`git describe` is a subprocess: it is called **once**, guarded (git absent, `.git` absent, non-zero
exit all fall through to `unknown`), and never on a request path. `/api/health` is polled by the UI
and must not spawn anything.

### 2. Two endpoints, split on what may be published

| Data | Endpoint | In the snapshot |
|---|---|---|
| app version + provenance, schema version, `schema_stale` | `/api/health` (the SPA already fetches it) | **yes** — a version string discloses nothing |
| paths, sources, storage, server binding | `/api/about` | **no** |

The topbar version badge is therefore live everywhere including the Pages demo, while `/about` is
hidden in snapshot mode via the established `{!SNAPSHOT && …}` pattern (`App.tsx:95` for Refresh;
throughout `SecurityView.tsx`).

This must be enforced in the component, **not** left to the link checker.
`scripts/check-snapshot-links.mjs` walks exported *payloads* and follows the links those payloads
would render — it never parses SPA source, so it cannot see a topbar link to a route with no
snapshot. That mistake would surface as a live 404 on Pages. See
[ADR-021](ADR-021-fixed-data-layout.md) and the snapshot-link gate's own header comment.

### 3. Storage metrics come from data already stored — no new table, no cache

Both numbers are free at request time:

- **DB size** — a single `stat()` on the db file.
- **Archive size** — `SELECT COUNT(*), SUM(size), MAX(ingested_at) FROM ingest_state`.

`ingest_state` already records `size` per archive file for the idempotent-skip check, and both
`pipeline.ts` and `sidecar.ts` write it, so the sum covers transcripts and sidecars alike. Measured
on a real 7,522-row store: **0.5 ms per aggregate**, over 0.90 GB of ingested bytes.

Because `ingest_state` *is* the ingest bookkeeping, the figure is "as of the last ingest" **by
construction**, and `MAX(ingested_at)` — already read by `lastIngested()` — comes back in the same
row to label it.

**Name it honestly.** This is *ingested bytes*, not `du -sh` of the archive directory: anything
present but not ingested (notably `.versions/` retention snapshots) is excluded. The UI says
"ingested", and a true disk-usage figure is explicitly out of scope — it would require the directory
walk this decision exists to avoid.

### 4. The surface is read-only. No configuration editing.

Configuration resolves `flag > env > config file > default`. A UI can only write **one** layer — the
config file — which sits third. An operator whose systemd unit sets `AGENT_LENS_DB` would change the
path, see it saved, and observe no effect, with the UI unable to explain why. That failure is
inherent to having precedence at all; it is not a polish problem. It would also expand the write
surface of a server that is read-only by design — the analytics handle is opened read-only per
[ADR-005](ADR-005-privacy-posture.md) (cited at `server/triage.ts:9`), with writes confined to the
triage/prefs sidecar ([ADR-018](ADR-018-security-triage-store.md)) and the single guarded refresh
action ([ADR-015](ADR-015-refresh-action-endpoint.md)).

The CLI already resolved this correctly by showing configuration read-only **with provenance**. The
web mirrors that. Changing configuration remains a CLI/env/file operation.

## Consequences

- The About page is a mirror of `agent-lens config` plus versions. **Read that command before
  changing the page's field list**, and change both together or they will drift into telling
  different stories.
- Server and web-build versions are shown together, with a warning when they differ. They cannot
  diverge in an npm install (the SPA ships prebuilt inside the CLI bundle); the warning is for
  development and for a stale installed service, which is precisely when it is worth having.
- Detector and classifier versions are stamped per row (`findings.detector_version`,
  `classifications`), so the page can report *"this data was classified by v2, this build is v3"* —
  making a pending `agent-lens-metrics` re-run visible rather than folklore.
- No schema change, no migration, no ingest change.
- `git describe` output is not semver (`v0.9.6-3-gabc1234`). Anything parsing the version field must
  tolerate that, which is why provenance is a sibling field rather than something to infer from the
  string's shape.

## Alternatives considered

- **Stamp the version at build time** (tsup/Vite `define`). Rejected: `release.yml` builds before
  `semantic-release` sets the version, so the published bundle would carry `0.0.0-development`.
  Fixable only by rebuilding inside the release via `@semantic-release/exec` — more release
  machinery, and a second way to be wrong, for no gain over resolving at runtime.
- **Commit the version back** by restoring `@semantic-release/git`. Rejected: it does
  `git push HEAD:main`, which the `protect-main` ruleset rejects — this is exactly what broke the
  release job and prompted PR #6. Re-adding it means weakening branch protection or granting the
  release bot a bypass token, which is a real posture cost to fix a cosmetic one.
- **A new `meta` key cached at ingest** for storage size. Rejected once the data was found to exist:
  `ingest_state.size` already holds it, and a cached copy would be a second source of truth that can
  go stale against the rows it summarizes. (Note the generic `meta` key-value table *does* already
  exist for `schema_version`, so this would not have needed a new table either — it simply is not
  needed at all.)
- **Walk the archive directory** for a true disk-usage figure. Rejected: an unbounded filesystem walk
  on a page load, for a number that is less meaningful than ingested bytes.
- **A configuration editor.** Rejected — see Decision 4.
- **Putting paths behind a redaction flag in the snapshot** rather than excluding the endpoint.
  Rejected: fail-open by construction. Excluding the endpoint means a mistake yields a missing page,
  not a leak.

## Related

- [ADR-005](ADR-005-privacy-posture.md) — local-only posture; the read-only analytics handle
- [ADR-015](ADR-015-refresh-action-endpoint.md) — the one guarded write action, and its precedent
- [ADR-016](ADR-016-npm-release-and-versioning.md) — why the version is not committed back
- [ADR-018](ADR-018-security-triage-store.md) — the one writable store, and its one-way ATTACH
- [ADR-021](ADR-021-fixed-data-layout.md) — fixed data layout the paths report
- [ADR-026](ADR-026-api-response-contracts.md) — `HealthResponse` lives in `@agent-lens/contracts`
