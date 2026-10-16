/**
 * snapshotFileKey has three copies by design — the SPA's (here), the exporter's, and the link
 * checker's tripwire — and check-snapshot-links.mjs only proves the exporter's output matches the
 * checker. These pinned keys tie the SPA's copy to the same values check-snapshot-links.mjs pins, so
 * a change to this one alone fails here instead of silently 404ing every /file page on the demo.
 */
import { describe, it, expect } from "vitest";
import { snapshotFileKey } from "../src/api";

// KEEP IN STEP with KEY_VECTORS in scripts/check-snapshot-links.mjs.
const KEY_VECTORS: Array<[string, string | null, string]> = [
  ["/repo/src/index.ts", "p1", "14dcd1agrya"],
  ["/repo/src/index.ts", null, "2cvfynf0gkm"],
  ["/ü/naïve file.md", "proj-2", "15yst67hqxq"],
];

describe("snapshotFileKey", () => {
  it("produces the pinned keys the exporter writes", () => {
    for (const [path, project, key] of KEY_VECTORS) expect(snapshotFileKey(path, project)).toBe(key);
  });
});
