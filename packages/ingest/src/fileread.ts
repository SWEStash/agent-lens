/**
 * Agent Lens — transcript file reading (ADR-010, impact 4).
 *
 * Small files are read whole (fast path); files larger than STREAM_THRESHOLD are streamed in fixed
 * chunks so ingest memory stays bounded regardless of transcript size. The streaming SHA-256 is
 * byte-identical to hashing a whole-file `readFileSync` buffer, so the incremental-skip check is
 * unaffected by which path a file takes. Kept separate from the CLI bootstrap so it is unit-testable.
 */
import { createHash } from "node:crypto";
import { openSync, readSync, closeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

export const STREAM_THRESHOLD = 8 * 1024 * 1024;
const CHUNK = 64 * 1024;

/** SHA-256 hex of a buffer. */
export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** SHA-256 hex of a file's bytes, computed by streaming. Equals sha256(readFileSync(path)). */
export function sha256File(path: string): string {
  const fd = openSync(path, "r");
  const h = createHash("sha256");
  const buf = Buffer.allocUnsafe(CHUNK);
  try {
    let n: number;
    while ((n = readSync(fd, buf, 0, CHUNK, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest("hex");
}

/**
 * Lazily yield a file's lines (newline-stripped) by streaming. A StringDecoder handles multibyte
 * characters split across chunk boundaries. Holds at most one line at a time, never the whole file.
 * Yields the same sequence as `readFileSync(path).toString("utf8").split("\n")` minus the trailing
 * empty element a final newline would produce (ingest skips blank lines anyway).
 */
export function* streamLines(path: string): Generator<string> {
  const fd = openSync(path, "r");
  const decoder = new StringDecoder("utf8");
  const buf = Buffer.allocUnsafe(CHUNK);
  let leftover = "";
  try {
    let n: number;
    while ((n = readSync(fd, buf, 0, CHUNK, null)) > 0) {
      leftover += decoder.write(buf.subarray(0, n));
      let idx: number;
      while ((idx = leftover.indexOf("\n")) !== -1) {
        yield leftover.slice(0, idx);
        leftover = leftover.slice(idx + 1);
      }
    }
    leftover += decoder.end();
    if (leftover.length > 0) yield leftover;
  } finally {
    closeSync(fd);
  }
}
