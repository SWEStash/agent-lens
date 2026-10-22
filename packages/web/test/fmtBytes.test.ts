/** fmtBytes: the one byte formatter in the UI — binary units, so 1 KB is 1024 B everywhere. */
import { describe, expect, it } from "vitest";
import { fmtBytes } from "../src/format";

describe("fmtBytes", () => {
  it("keeps bytes below 1 KB as bytes", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(1023)).toBe("1023 B");
  });

  it("uses 1024 per step, one decimal below 10, whole numbers above", () => {
    expect(fmtBytes(1024)).toBe("1.0 KB");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(20 * 1024)).toBe("20 KB");
    expect(fmtBytes(3 * 1024 ** 2)).toBe("3.0 MB");
    expect(fmtBytes(1.2 * 1024 ** 3)).toBe("1.2 GB");
  });

  it("stops at TB", () => {
    expect(fmtBytes(5000 * 1024 ** 4)).toBe("5000 TB");
  });
});
