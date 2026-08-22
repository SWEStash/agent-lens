/**
 * The timezone fold is the one piece of Part II that cannot be checked by eye — a wrong offset
 * produces a plausible chart. Every case pins an explicit zone and a fixed instant; none of them may
 * read the host zone, which is UTC-3 and would hide exactly the bugs worth catching.
 */
import { describe, it, expect } from "vitest";
import { localParts, resolveZone, zoneLabel } from "../src/tz";

describe("localParts", () => {
  it("shifts an hour backwards across the date line into the previous local day", () => {
    // 2026-03-02T01:00Z is still Sunday the 1st, 22:00, in Buenos Aires.
    expect(localParts("2026-03-02T01", "America/Argentina/Buenos_Aires")).toEqual({
      weekday: 0,
      hour: 22,
      dayKey: "2026-03-01",
    });
  });

  it("shifts forwards over the date line", () => {
    // 2026-03-01T22:00Z is already Monday the 2nd, 07:00, in Tokyo.
    expect(localParts("2026-03-01T22", "Asia/Tokyo")).toEqual({ weekday: 1, hour: 7, dayKey: "2026-03-02" });
  });

  it("is the identity for UTC", () => {
    expect(localParts("2026-03-01T22", "UTC")).toEqual({ weekday: 0, hour: 22, dayKey: "2026-03-01" });
  });

  it("follows a DST transition instead of applying one fixed offset", () => {
    // New York moves to UTC-4 on 2026-03-08. The same UTC hour maps to a different local hour on
    // either side of it — which is precisely what a server-side ±HH:MM offset could not do.
    expect(localParts("2026-03-07T12", "America/New_York")?.hour).toBe(7); // EST, UTC-5
    expect(localParts("2026-03-09T12", "America/New_York")?.hour).toBe(8); // EDT, UTC-4
  });

  it("maps local midnight to hour 0, not 24", () => {
    expect(localParts("2026-03-02T03", "America/Argentina/Buenos_Aires")?.hour).toBe(0);
  });

  it("returns null for a key it cannot parse rather than throwing", () => {
    expect(localParts("not-a-date", "UTC")).toBeNull();
  });
});

describe("resolveZone", () => {
  it("prefers an explicitly pinned zone", () => {
    expect(resolveZone("Europe/Berlin")).toBe("Europe/Berlin");
  });

  it("falls back to a resolvable zone when nothing is pinned", () => {
    expect(resolveZone(null)).toBeTruthy();
  });
});

describe("zoneLabel", () => {
  it("names the offset in force at the given instant", () => {
    expect(zoneLabel("America/New_York", new Date("2026-03-07T12:00:00Z"))).toBe("GMT-5");
    expect(zoneLabel("America/New_York", new Date("2026-03-09T12:00:00Z"))).toBe("GMT-4");
  });
});
