# ADR-029 — SQLite via Node's built-in `node:sqlite`, dropping the native `better-sqlite3`

- Status: Accepted
- Date: 2026-08-01
- Deciders: project owner
- Supersedes the driver half of [ADR-003](ADR-003-data-model-and-store.md); amends
  [ADR-016](ADR-016-npm-release-and-versioning.md) §2

## Context

`better-sqlite3` was agent-lens's **only** compiled dependency. npm 11 gates install scripts by
default, so a plain `npm install @swestash/agent-lens` printed:

```
npm warn deprecated prebuild-install@7.1.3: No longer maintained.
npm warn allow-scripts 1 package has install scripts not yet covered by allowScripts:
npm warn allow-scripts   better-sqlite3@12.11.1 (install: prebuild-install || node-gyp rebuild --release)
```

That is not cosmetic. With the script declined, `agent-lens collect` still works — it touches no
database — but `agent-lens ingest` dies on a raw `Could not locate the bindings file` dump listing
eight candidate paths, with nothing pointing at the npm prompt that caused it. A user following npm's
own supply-chain advice gets a half-working tool and an inscrutable stack trace.

Node 24 — already our `engines` floor — ships `node:sqlite`. Adopting it removes the compiled
dependency outright: no install script, no prebuild fetch, no node-gyp fallback, no warning.

The blocking question was whether it is a like-for-like replacement. Measured against the real
43.5k-event store before committing:

- **Existing databases are read as-is.** `node:sqlite` (SQLite 3.51.3) opened a store written by
  better-sqlite3 (3.53.2) and read it correctly — 43,510 events, FTS5 `MATCH` resolving against the
  **existing** index, WAL preserved, `readOnly` enforced. SQLite's file format is stable across both
  versions, so this is a driver swap, not a data migration.
- **Writes get faster; reads get slightly slower.** Bulk insert of 50k rows in one transaction:
  **15–23% faster** across four runs (the ingest hot path). Reads are 1.0–1.45× slower, the cost
  concentrated in materializing rows into JS objects — negligible for `count(*)`/FTS (≈1.0×), largest
  on a full 43.5k-row scan (72ms → 96ms). Every paginated endpoint moves by well under a millisecond.
- **Behaviour matches where it matters.** `foreign_keys` defaults ON in both; both reject
  double-quoted string literals; both throw `datatype mismatch` on a float-to-integer bind (which
  `pageOffset`'s contract test depends on); neither can bind an array, so the `temp._dirty` design in
  [ADR-010](ADR-010-incremental-scalable-ingest.md) is untouched. No `ExperimentalWarning` on 24.15.

## Decision

**Use `node:sqlite` (`DatabaseSync`) as the only SQLite driver. Remove `better-sqlite3` entirely.**

1. **No migration, no schema bump.** Existing `agent-lens.db` and `triage.db` files are opened
   in place. No re-ingest, no `SCHEMA_VERSION` change.
2. **One compatibility shim, in `packages/core/src/sqlite.ts`.** `node:sqlite` has no
   `db.transaction(fn)`. `transaction(db, fn)` reproduces better-sqlite3's semantics — returns a
   *callable*, `BEGIN`/`COMMIT`, `ROLLBACK`-and-rethrow, `SAVEPOINT` when already inside a
   transaction — so all 13 call sites keep their shape. It lives in `core` because both `ingest` and
   `server` need it.
3. **No `pragma()` wrapper.** Every write-site ignored better-sqlite3's return value, so
   `db.pragma("foreign_keys = OFF")` becomes `db.exec("PRAGMA foreign_keys = OFF")`. The one site
   that reads a pragma (`PRAGMA database_list`) already used the portable `prepare().all()` form.
4. **Casts stay at the existing boundaries.** `node:sqlite` types rows as
   `Record<string, SQLOutputValue>` and named parameters as `Record<string, SQLInputValue>`, which
   declared interfaces do not satisfy. The read cast stays in the server's `queryAll`/`queryGet`; a
   matching write-side helper, `runNamed`, joins `transaction` in `core`.
5. **`openReadonly` uses `{ readOnly: true }`.** That also supplies the old `fileMustExist` —
   `node:sqlite` will not create a database it may not write. `PRAGMA query_only` stays on top.

## Consequences

- **agent-lens installs with no compiled dependencies.** No install script to approve, no C++
  toolchain fallback, no prebuilt-binary matrix to track per Node ABI and platform.
- **The `raw_json` codec had to widen.** `node:sqlite` returns BLOBs as plain `Uint8Array`, not
  `Buffer`. `unpackRaw` gated on `Buffer.isBuffer`, which is **false** for a `Uint8Array` — it would
  have skipped the gunzip and returned compressed bytes as if they were a legacy plain-text row,
  breaking transcript rendering for every event. It now takes `Uint8Array` (which `Buffer` satisfies,
  being a subclass). The ADR-011 round-trip test caught this; it now asserts the BLOB type rather
  than `Buffer` so the trap cannot reappear.
- **The bundle must keep the `node:` prefix.** tsup 8 rewrites `node:foo` imports to bare `foo` by
  default (`removeNodeProtocol`), which is harmless for `fs`/`zlib`/`crypto` — they resolve either
  way — but fatal for `node:sqlite`, which is **prefix-only**. Stripped to `"sqlite"` it resolves to
  nothing and the published CLI dies on startup with `ERR_MODULE_NOT_FOUND`. `removeNodeProtocol` is
  therefore `false` in `packages/cli/tsup.config.ts`.

  esbuild itself preserves the prefix at every target, so this is tsup's rewrite, not a bundler
  limitation. It matters beyond this one flag: the **test suite cannot catch it**, because every
  suite imports each package's `tsc` output, which keeps the prefix. Only the global from-tarball
  smoke (`scripts/smoke-tarball.mjs --global`) exercises the bundle, which is the reason that gate
  stays in the release workflow now that there is no prebuild for it to test.
- **`.changes` is `number | bigint`** and needs coercion where a count is returned (`reopen`,
  `unmute`, `canonicalize`).
- **Rows are null-prototype objects.** Spread, `Object.keys`, `JSON.stringify` and vitest's `toEqual`
  are unaffected; `hasOwnProperty` on a row and `toStrictEqual` are not. Documented in `sqlite.ts`.
- **A slight engine downgrade** (3.51.3 vs 3.53.2) — tied to the Node release rather than a dependency
  bump. Acceptable: we use no syntax newer than 3.51, and the test suite gates it.
- Two latent `foreign_keys` leaks were fixed in passing: `pruneExcluded` and `resetSchema` left the
  connection with enforcement **off** for the rest of the process if their body threw. Both are now
  `try/finally`. The toggle must stay *outside* the transaction — `PRAGMA foreign_keys` is a silent
  no-op inside one.

## Alternatives considered

- **Keep better-sqlite3 and document `npm approve-scripts`.** Rejected: it pushes a supply-chain
  decision onto every user for a dependency we no longer need, and leaves the confusing failure mode
  intact for anyone who declines.
- **Keep better-sqlite3, improve the error message.** A real improvement, but strictly worse than
  removing the failure mode — and it keeps the toolchain fallback and prebuild matrix.
- **Keep both behind an adapter, selecting at runtime.** Rejected: two drivers to test, for a
  local-only single-user tool with one supported Node major. The `DB` type aliases already give a
  seam if that ever changes.
- **`node:sqlite`'s async `DatabaseSync` alternatives / worker offload.** Not applicable — the
  synchronous, single-writer model is deliberate (ADR-003) and the read deltas are sub-millisecond.

## Related

- [ADR-003](ADR-003-data-model-and-store.md) — the store and schema this replaces the driver for
- [ADR-010](ADR-010-incremental-scalable-ingest.md) — `temp._dirty`; its no-array-binding premise holds
- [ADR-011](ADR-011-compressed-raw-json.md) — the `raw_json` BLOB codec that had to widen
- [ADR-012](ADR-012-single-cli-distribution.md) — the bundle's external list, now one entry shorter
- [ADR-016](ADR-016-npm-release-and-versioning.md) — the prebuild rationale this supersedes
- [ADR-018](ADR-018-security-triage-store.md) — the ATTACHed triage sidecar, verified under `readOnly`
