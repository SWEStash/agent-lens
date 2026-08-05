/**
 * Transcript view prefs. These were the only prefs stored by hand, unencoded, with no
 * server write-through. Moving them onto prefs.ts changes the on-disk format, so the legacy shape
 * must keep loading — otherwise every existing user silently loses both choices on upgrade.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
const fetchMock = vi.fn();
vi.mock("../src/api", () => ({ api: (p: string) => api(p), SNAPSHOT: false }));

const { loadFormat, loadHideTools, saveFormat, saveHideTools, fetchViewPrefs } = await import("../src/transcript/viewPrefs");

beforeEach(() => {
  localStorage.clear();
  api.mockReset();
  fetchMock.mockReset().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("defaults", () => {
  it("falls back to markdown / tools-shown when nothing is stored", () => {
    expect(loadFormat()).toBe("markdown");
    expect(loadHideTools()).toBe(false);
  });
});

describe("legacy values still load", () => {
  it("reads the unencoded format string", () => {
    localStorage.setItem("agentlens.msgFormat", "raw");
    expect(loadFormat()).toBe("raw");
  });

  it("reads the unencoded hide-tools flag in both states", () => {
    localStorage.setItem("agentlens.hideTools", "1");
    expect(loadHideTools()).toBe(true);
    localStorage.setItem("agentlens.hideTools", "0");
    expect(loadHideTools()).toBe(false);
  });
});

describe("round-trip through the shared prefs module", () => {
  it("saves JSON under the same key and reads it back", () => {
    saveFormat("raw");
    expect(localStorage.getItem("agentlens.msgFormat")).toBe('"raw"');
    expect(loadFormat()).toBe("raw");

    saveHideTools(true);
    expect(localStorage.getItem("agentlens.hideTools")).toBe("true");
    expect(loadHideTools()).toBe(true);
  });

  it("writes through to the server, which the hand-rolled version never did", () => {
    saveFormat("raw");
    saveHideTools(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/prefs/msgFormat", "/api/prefs/hideTools"]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "PUT", body: JSON.stringify({ value: "raw" }) });
  });

  it("a legacy value is rewritten in the new format on the next save", () => {
    localStorage.setItem("agentlens.msgFormat", "raw");
    saveFormat(loadFormat());
    expect(localStorage.getItem("agentlens.msgFormat")).toBe('"raw"');
  });
});

describe("fetchViewPrefs", () => {
  it("returns only the prefs the server has an opinion on", async () => {
    api.mockImplementation((p: string) =>
      p === "/prefs/msgFormat" ? Promise.resolve({ value: "raw" }) : Promise.resolve({ value: null }),
    );
    expect(await fetchViewPrefs()).toEqual({ format: "raw" });
  });

  it("coerces a stored value rather than trusting it", async () => {
    api.mockResolvedValue({ value: "nonsense" });
    expect(await fetchViewPrefs()).toEqual({ format: "markdown", hideTools: false });
  });

  it("returns nothing when the server is unreachable or has no writable store", async () => {
    api.mockRejectedValue(new Error("offline"));
    expect(await fetchViewPrefs()).toEqual({});
  });
});
