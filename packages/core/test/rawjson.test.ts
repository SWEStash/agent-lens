/**
 * raw_json storage codec (ADR-011). These tests cover OUR contract — that packRaw/unpackRaw compose to
 * identity, and that unpackRaw dispatches correctly across the three value shapes it must accept (gzip
 * BLOB, legacy plain Buffer, legacy plain string). We do not assert zlib's own behavior (that it emits a
 * gzip header or that it shrinks data) — that is the library's job, not ours.
 */
import { describe, it, expect } from "vitest";
import { packRaw, unpackRaw } from "../dist/rawjson.js";

const LINE = JSON.stringify({ uuid: "u1", message: { content: [{ type: "text", text: "héllo — 世界 🌍" }] } });

describe("raw_json codec", () => {
  it("round-trips: unpackRaw(packRaw(x)) === x (incl. multibyte content)", () => {
    expect(unpackRaw(packRaw(LINE))).toBe(LINE);
  });

  it("dispatches a legacy plain string unchanged", () => {
    expect(unpackRaw(LINE)).toBe(LINE);
  });

  it("dispatches a non-gzip Buffer to utf8 (legacy pre-migration row)", () => {
    // A BLOB that does not start with the gzip magic bytes must be decoded as plain utf8 — this is the
    // branch that keeps a not-yet-migrated DB readable.
    expect(unpackRaw(Buffer.from(LINE, "utf8"))).toBe(LINE);
  });
});
