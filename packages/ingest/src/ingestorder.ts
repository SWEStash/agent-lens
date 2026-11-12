/**
 * The order a run ingests its files in (ADR-038). An event belongs to the first session that stores
 * it, and a continued or forked session repeats its original's lines under the same uuids. So within
 * one run the original has to go first, and file order (readdir, mtime) cannot be trusted to put it
 * there: Claude Code keeps appending to the old file after the handoff.
 *
 * Content can. A copy repeats its original's opening lines, so the first timestamps tie. Among ties,
 * a file that hands off (`continued-in`, appended to the original) goes first; otherwise the earlier
 * last timestamp does, since the original stopped at the handoff while its copy went on.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** How much of each end of a file to scan. A transcript line is rarely longer. */
const EDGE_BYTES = 64 * 1024;
const FIRST_TIMESTAMP = /"timestamp":"([^"]+)"/;
const TIMESTAMP = new RegExp(FIRST_TIMESTAMP.source, "g");
const HANDOFF = '"type":"continued-in"';

export interface ContentSpan {
  /** The first and last line timestamps found at the file's two ends; "" when there are none. */
  first: string;
  last: string;
  /** The tail holds a `continued-in` pointer: this session handed off to another. */
  handsOff: boolean;
}

function readAt(fd: number, position: number, length: number): string {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, position);
  return buf.toString("utf8", 0, n);
}

/** A copy of `s` that shares no storage with the string it was cut from. V8 keeps a regex match or
 * slice of a long string as a view into it, so a timestamp matched in a 64 KB edge read would keep
 * all 64 KB alive for as long as the span lives — and `ingest --full` keeps one span per pending file
 * until the whole file loop ends (#93). */
function detach(s: string): string {
  return Buffer.from(s, "utf8").toString("utf8");
}

/** First and last timestamps of a transcript, from at most EDGE_BYTES at each end. */
export function contentSpan(path: string): ContentSpan {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const head = readAt(fd, 0, Math.min(size, EDGE_BYTES));
    const tail = size > EDGE_BYTES ? readAt(fd, size - EDGE_BYTES, EDGE_BYTES) : head;
    const first = head.match(FIRST_TIMESTAMP)?.[1] ?? "";
    let last = "";
    for (const m of tail.matchAll(TIMESTAMP)) last = m[1];
    return { first: detach(first), last: detach(last), handsOff: tail.includes(HANDOFF) };
  } finally {
    closeSync(fd);
  }
}

/**
 * Mirror files before `.versions/` snapshots (so the mirror's copy of a line wins its canonical
 * fields), then oldest content first, a hand-off before its copy, then path, so equal spans still
 * order the same way every run.
 */
export function compareIngestOrder(
  a: { path: string; isVersion: boolean; span: ContentSpan },
  b: { path: string; isVersion: boolean; span: ContentSpan },
): number {
  return (
    Number(a.isVersion) - Number(b.isVersion) ||
    cmp(a.span.first, b.span.first) ||
    Number(b.span.handsOff) - Number(a.span.handsOff) ||
    cmp(a.span.last, b.span.last) ||
    cmp(a.path, b.path)
  );
}

const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
