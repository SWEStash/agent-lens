/**
 * Presets reference registry ids by string. A typo doesn't fail a build or throw at runtime — the tile
 * simply never appears in that view, and nobody notices until they wonder where the cost KPI went.
 * This is the only thing that catches it.
 */
import { describe, expect, it } from "vitest";
import { PRESETS } from "../src/dashboard/presets";
import { KPI_REGISTRY } from "../src/dashboard/Kpis";
import { CHART_REGISTRY } from "../src/dashboard/registry";

const KPI_IDS = new Set(KPI_REGISTRY.map((k) => k.id));
const CHART_IDS = new Set(CHART_REGISTRY.map((c) => c.id));

describe("preset ids match the registries", () => {
  for (const preset of PRESETS) {
    it(`${preset.id} names only real ids`, () => {
      expect((preset.kpis ?? []).filter((id) => !KPI_IDS.has(id))).toEqual([]);
      expect((preset.charts ?? []).filter((id) => !CHART_IDS.has(id))).toEqual([]);
    });

    it(`${preset.id} lists no duplicates`, () => {
      expect(new Set(preset.kpis ?? []).size).toBe((preset.kpis ?? []).length);
      expect(new Set(preset.charts ?? []).size).toBe((preset.charts ?? []).length);
    });
  }

  it("has unique preset ids and an 'all' view", () => {
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    expect(PRESETS.map((p) => p.id)).toContain("all");
  });

  it("never uses 'custom' as a preset id — it names the user's own layout", () => {
    expect(PRESETS.map((p) => p.id)).not.toContain("custom");
  });

  it("leaves no curated view empty", () => {
    for (const p of PRESETS.filter((p) => p.id !== "all")) {
      expect((p.kpis?.length ?? 0) + (p.charts?.length ?? 0)).toBeGreaterThan(0);
    }
  });
});
