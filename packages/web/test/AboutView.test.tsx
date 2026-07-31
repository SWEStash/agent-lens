/**
 * /about — the diagnostics page (ADR-027). What matters here is that it reports honestly: a stale
 * schema, a non-loopback bind, and a server/UI version mismatch all have to be *visible*, because
 * each one silently invalidates what the rest of the app is showing you.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AboutResponse } from "../src/api";

const api = vi.fn();
vi.mock("../src/api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/api");
  return { ...actual, api: (...args: unknown[]) => api(...args), SNAPSHOT: false };
});
// Pin the build stamp so the mismatch assertions are about the comparison, not the ambient revision.
vi.mock("../src/buildInfo", () => ({ BUILD_VERSION: "v9.9.9-test" }));

import AboutView from "../src/AboutView";

const base: AboutResponse = {
  versions: { app: "v9.9.9-test", app_source: "git", schema: 14, schema_expected: 14, schema_stale: false },
  paths: {
    config_file: null,
    data_dir: { path: "/home/u/.local/share/agent-lens", origin: "default" },
    archive: { path: "/home/u/.local/share/agent-lens/archive", origin: "fixed" },
    db: { path: "/home/u/.local/share/agent-lens/agent-lens.db", origin: "env" },
    triage_db: { path: "/home/u/.local/share/agent-lens/triage.db", origin: "fixed" },
  },
  server: { host: "127.0.0.1", port: 4477, loopback_only: true },
  sources: [{ label: "personal", agent: "claude-code", config_dir: "/home/u/.claude" }],
  storage: { db_bytes: 790_000_000, archive_bytes: 903_337_568, archive_files: 7522, last_ingested: "2026-07-30T12:00:00Z" },
};

async function renderAbout(patch: Partial<AboutResponse> = {}) {
  api.mockResolvedValue({ ...base, ...patch });
  render(
    <MemoryRouter>
      <AboutView />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText("Versions")).toBeTruthy());
}

beforeEach(() => {
  api.mockReset();
});
afterEach(cleanup);

describe("AboutView", () => {
  it("fetches /about", async () => {
    await renderAbout();
    expect(api).toHaveBeenCalledWith("/about");
  });

  it("shows each path with the layer it came from", async () => {
    await renderAbout();
    expect(screen.getByText("/home/u/.local/share/agent-lens/agent-lens.db")).toBeTruthy();
    expect(screen.getAllByText("fixed").length).toBe(2); // archive + triage store
    expect(screen.getByText("env")).toBeTruthy(); // the db path came from an env var
  });

  it("reports ingested bytes in SI units, not the archive's size on disk", async () => {
    await renderAbout();
    expect(screen.getByText(/903 MB/)).toBeTruthy();
    expect(screen.getByText(/7,522 files/)).toBeTruthy();
    // The distinction is the whole reason the number is trustworthy — it must be stated, not implied.
    expect(screen.getByText(/not the archive folder/i)).toBeTruthy();
  });

  it("stays quiet when the server and UI builds agree", async () => {
    await renderAbout();
    expect(screen.queryByText(/differs from the server/i)).toBeNull();
  });

  it("warns when the UI build differs from the server", async () => {
    await renderAbout({ versions: { ...base.versions, app: "v1.0.0-other" } });
    expect(screen.getByText(/differs from the server/i)).toBeTruthy();
  });

  it("flags a stale schema and names the fix", async () => {
    await renderAbout({ versions: { ...base.versions, schema: 9, schema_stale: true } });
    expect(screen.getByText("stale")).toBeTruthy();
    expect(screen.getByText(/agent-lens ingest --full/)).toBeTruthy();
  });

  it("flags a non-loopback bind as the exposure it is", async () => {
    await renderAbout({ server: { host: "0.0.0.0", port: 4477, loopback_only: false } });
    expect(screen.getByText(/non-loopback bind/i)).toBeTruthy();
    expect(screen.getByText(/unauthenticated/i)).toBeTruthy();
  });

  it("says so when no config file is in use, rather than showing a blank", async () => {
    await renderAbout();
    expect(screen.getByText(/using built-in defaults/i)).toBeTruthy();
  });

  it("explains an unknown version instead of leaving it bare", async () => {
    await renderAbout({ versions: { ...base.versions, app: "unknown", app_source: "unknown" } });
    expect(screen.getByText(/unreleased or archive build/i)).toBeTruthy();
  });
});
