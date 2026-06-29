# ADR-011 — Compressed `raw_json` at rest (gzip BLOB) with transparent decode

- Status: Accepted
- Date: 2026-06-29
- Deciders: project owner
- Extends: ADR-001 (two-stage collection), ADR-003 (data model)

## Context

`events.raw_json` keeps every transcript line verbatim for lossless re-derivation (ADR-003) — it is the
in-DB copy of the source bytes and the largest contributor to database growth. On the current corpus the
store was 382 MB, dominated by these `TEXT` blobs, while the underlying archive is 257 MB. The verbatim
text is read in exactly one place: the server's `extractParts` (`packages/server/src/db.ts`), which
`JSON.parse`s it to split message content into natural text vs. thinking for the transcript view. No SQL
queries inspect `raw_json` (FTS indexes the separate extracted `text` column, not `raw_json`), so the
column does not need to be human-readable at rest.

## Decision

Store `raw_json` gzip-compressed as a **BLOB** with a single shared codec and transparent decode.

- **Schema.** `events.raw_json` becomes `BLOB NOT NULL` (was `TEXT`); `SCHEMA_VERSION` is bumped to 5.
- **Codec** (`packages/core/src/rawjson.ts`, exported from the package barrel — one chokepoint reused by
  writer and reader):
  - `packRaw(json: string): Buffer` = `gzipSync`.
  - `unpackRaw(value: string | Buffer): string` = if the value is a Buffer beginning with the gzip
    magic bytes `0x1f 0x8b`, `gunzipSync`; if a non-gzip Buffer, decode as UTF-8; if a string, return as
    is. JSON never starts with `0x1f`, so the magic-byte sniff is unambiguous and lets a reader handle a
    **mix** of compressed and legacy-plain rows.
- **Write path.** Compression happens at the single ingest insert chokepoint (`ingestFile`, at
  `insEvent`); adapters stay agent-agnostic and still emit a plain string `raw_json` (ADR-008).
- **Read path.** `extractParts` accepts `string | Buffer` and calls `unpackRaw` before parsing.
- **Migration.** `applySchema` (CREATE IF NOT EXISTS) does not alter an existing column, so the BLOB
  change takes effect via one `agent-lens-ingest --full` — the drop-and-rebuild path that already serves
  as the migration mechanism (ADR-001). `--full` re-reads the **uncompressed** archive `.jsonl`, so it
  never needs to decompress; the codec is purely for DB-side readers. Because `unpackRaw` also reads
  legacy plain rows, a not-yet-migrated DB keeps working until `--full` is run — graceful, not a hard
  break.

## Consequences

- Database size dropped **382 MB → 224 MB (~41%)** on the current corpus for identical content; the
  saving grows with history.
- One-time migration: existing deployments run `agent-lens-ingest --full` once after upgrading (see the
  ingest runbook). No code path other than `extractParts` touched `raw_json`, so blast radius is minimal.
- A negligible CPU cost (gzip on write, gunzip on the rare transcript-detail read). Token counting,
  dashboards, search, and classification never decompress — they read the projected columns.
- `raw_json` is no longer human-readable via a raw SQLite dump; inspection goes through `unpackRaw`.

## Alternatives considered

- **`base64(gzip)` in the existing TEXT column.** Avoids the schema change/migration, but wastes ~33% to
  base64 and is less clean. Rejected: `--full` migration is already a supported, safe operation.
- **Compress only lines above a size threshold.** Saves CPU on tiny control lines; the magic-byte read
  supports it for free. Deferred as a future tuning knob — gzip-all is simpler and the CPU cost is not a
  bottleneck.
- **Per-row compression flag column.** Redundant given magic-byte sniffing.
- **Don't store `raw_json` at all** (re-derive from the archive on demand). Rejected: violates the
  self-contained-DB property and the lossless-re-derivation guarantee (ADR-001/003).
