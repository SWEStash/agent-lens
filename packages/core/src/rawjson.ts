/**
 * Agent Lens — `events.raw_json` storage codec (ADR-011).
 *
 * Every transcript line is kept verbatim in `events.raw_json` for lossless re-derivation. That column
 * dominates DB growth, so it is stored gzip-compressed as a BLOB. This module is the single chokepoint:
 * the ingest writer compresses with `packRaw`, the server reader decompresses with `unpackRaw`.
 *
 * `unpackRaw` sniffs the gzip magic bytes (0x1f 0x8b) so it transparently handles a mix of compressed
 * BLOBs and legacy plain-text rows (a DB written before the migration, or read before `--full` runs).
 * JSON always begins with `{`/`[`/`"`/whitespace, never 0x1f, so the sniff is unambiguous.
 */
import { gzipSync, gunzipSync } from "node:zlib";

/** Compress a raw transcript line for storage in `events.raw_json` (BLOB). */
export function packRaw(json: string): Buffer {
  return gzipSync(Buffer.from(json, "utf8"));
}

/** Decompress a stored `raw_json` value. Accepts gzip BLOBs and legacy plain text/strings. */
export function unpackRaw(value: string | Buffer): string {
  if (Buffer.isBuffer(value)) {
    if (value.length >= 2 && value[0] === 0x1f && value[1] === 0x8b) {
      return gunzipSync(value).toString("utf8");
    }
    return value.toString("utf8");
  }
  return value;
}
