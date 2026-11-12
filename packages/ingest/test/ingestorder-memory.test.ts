/**
 * `ingest --full` keeps a content span for every pending file until the file loop ends (run.ts), so a
 * span must not pin the 64 KB edge strings it was read from (#93). In V8 a regex match is a sliced
 * string that keeps its whole source alive; across tens of thousands of files that exhausted the heap.
 * Measured in a child process with --expose-gc so the heap reading is the retained size, not garbage.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const N = 200;

describe("contentSpan memory (#93)", () => {
  it("retains only the timestamps, not the file edges they were read from", () => {
    const dir = mkdtempSync(join(tmpdir(), "al-span."));
    try {
      // Each file is larger than both 64 KB edges, with timestamps at its start and end.
      const filler = JSON.stringify({ type: "assistant", message: { content: "x".repeat(2000) } });
      const body = Array.from({ length: 80 }, () => filler).join("\n");
      for (let i = 0; i < N; i++) {
        const head = JSON.stringify({ type: "user", timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z` });
        const tail = JSON.stringify({ type: "assistant", timestamp: "2026-01-02T00:00:00.000Z" });
        writeFileSync(join(dir, `s${i}.jsonl`), `${head}\n${body}\n${body}\n${tail}\n`);
      }
      const mod = new URL("../dist/ingestorder.js", import.meta.url).href;
      const script = `
        const { contentSpan } = await import(${JSON.stringify(mod)});
        const { readdirSync } = await import("node:fs");
        const files = readdirSync(${JSON.stringify(dir)}).map((f) => ${JSON.stringify(dir)} + "/" + f);
        gc(); const before = process.memoryUsage().heapUsed;
        const kept = files.map((f) => contentSpan(f));
        gc(); const after = process.memoryUsage().heapUsed;
        if (kept.some((s) => !s.first || !s.last)) throw new Error("span missing a timestamp");
        console.log(String((after - before) / kept.length));
      `;
      const perSpan = Number(execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], { encoding: "utf8" }).trim());
      // Two short timestamps and a small object: well under 2 KB. Pinning the edges costs ~128 KB+.
      expect(perSpan).toBeLessThan(2048);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
