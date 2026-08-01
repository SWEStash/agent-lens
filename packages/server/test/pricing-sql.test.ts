/**
 * The session list orders by cost in SQL (a rates CTE), while the cost it *displays* still comes from
 * `costForUsage` in JS. Two implementations of one formula — so these tests pin them together.
 *
 * Two things can silently diverge, and both are regressions this file exists to catch:
 *   1. **Prefix matching.** `rateForModel` takes the LONGEST matching prefix, so a dated id like
 *      `claude-haiku-4-5-20251001` resolves to `claude-haiku-4`. An equality join would price it at
 *      zero — the exact silent-$0 failure ADR-028 was cut to fix.
 *   2. **Config overrides.** Pricing is overridable (ADR-028) and `rateForModel` reads the *active*
 *      table, so a CTE built from the built-in PRICE_TABLE would ignore user rates and order the list
 *      by numbers that contradict every figure on screen.
 */
import { describe, it, expect, afterEach } from "vitest";
import { costForUsage, activePricing, usePricing, PRICE_TABLE, SYNTHETIC_MODEL } from "@agent-lens/core";
import { listSessions } from "../dist/db.js";
import { freshDb, addProject, addSession, addEvent, addTokens } from "./helpers/seed.js";
import type { DatabaseSync } from "node:sqlite";

/** Models chosen to exercise each matching path: exact hit, longest-prefix, dated variant, unknown. */
const USAGE: Array<[session: string, model: string, input: number, output: number]> = [
  ["s-exact", "claude-opus-4-8", 1_000_000, 500_000],
  ["s-prefix", "claude-haiku-4-5-20251001", 2_000_000, 100_000],
  ["s-legacy", "claude-opus-4", 300_000, 900_000],
  ["s-unknown", "model-that-does-not-exist", 5_000_000, 5_000_000],
  ["s-synthetic", SYNTHETIC_MODEL, 400_000, 400_000],
];

function seedCosted(): DatabaseSync {
  const db = freshDb();
  addProject(db, "p1", "/w/p1");
  for (const [id, model, input, output] of USAGE) {
    addSession(db, id, { project: "p1", title: id });
    addEvent(db, id, `e-${id}`, { model });
    addTokens(db, `e-${id}`, id, model, { input, output });
  }
  return db;
}

/** What the JS pricing path says each seeded session costs — the number the UI renders. */
function expectedCosts(): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, model, input, output] of USAGE) {
    out.set(
      id,
      costForUsage(model, {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    );
  }
  return out;
}

/** Session ids in the order the SQL cost sort returns them. */
const sortedByCost = (db: DatabaseSync, dir: "asc" | "desc") =>
  listSessions(db, { sort: "cost", dir, limit: 50, offset: 0 }).sessions.map((s) => s.id);

/** The same ordering derived independently from `costForUsage`, with the id tiebreak the SQL uses. */
function expectedOrder(dir: "asc" | "desc"): string[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...expectedCosts().entries()]
    .sort((a, b) => (a[1] - b[1]) * sign || a[0].localeCompare(b[0]))
    .map(([id]) => id);
}

afterEach(() => usePricing(PRICE_TABLE)); // the active table is module state — never leak it between tests

describe("SQL cost sort agrees with costForUsage", () => {
  it("orders by cost identically to the JS pricing path, both directions", () => {
    const db = seedCosted();
    expect(sortedByCost(db, "desc")).toEqual(expectedOrder("desc"));
    expect(sortedByCost(db, "asc")).toEqual(expectedOrder("asc"));
  });

  it("prices a dated model id by longest prefix, not exact match", () => {
    const db = seedCosted();
    const haiku = listSessions(db, { sort: "cost", dir: "desc", limit: 50, offset: 0 }).sessions.find(
      (s) => s.id === "s-prefix",
    )!;
    // Resolves to the `claude-haiku-4` rate; an equality join would have made this 0 and sorted it last.
    expect(haiku.cost).toBeCloseTo(expectedCosts().get("s-prefix")!, 10);
    expect(haiku.cost).toBeGreaterThan(0);
    expect(sortedByCost(db, "asc").indexOf("s-prefix")).toBeGreaterThan(0);
  });

  it("treats an unknown model as zero-cost, and keeps <synthetic> out of unpriced_models", () => {
    const db = seedCosted();
    const rows = listSessions(db, { sort: "cost", dir: "asc", limit: 50, offset: 0 }).sessions;
    const unknown = rows.find((s) => s.id === "s-unknown")!;
    const synthetic = rows.find((s) => s.id === "s-synthetic")!;
    expect(unknown.cost).toBe(0);
    expect(unknown.unpriced_models).toEqual(["model-that-does-not-exist"]);
    expect(synthetic.cost).toBe(0);
    expect(synthetic.unpriced_models).toEqual([]); // never had an API cost — ADR-028
  });

  it("follows a config pricing override rather than the built-in table", () => {
    const db = seedCosted();
    const before = listSessions(db, { sort: "cost", dir: "asc", limit: 50, offset: 0 }).sessions;
    expect(before.find((s) => s.id === "s-unknown")!.cost).toBe(0); // unpriced, so tied at the cheap end

    // Make the previously-unknown model the most expensive thing in the corpus. If the CTE were built
    // from PRICE_TABLE instead of activePricing(), this session would stay at 0 and never move.
    usePricing({
      ...PRICE_TABLE,
      "model-that-does-not-exist": { input: 1000, output: 5000, cacheWrite: 1250, cacheRead: 100 },
    });
    expect(activePricing()["model-that-does-not-exist"]).toBeDefined();

    const after = listSessions(db, { sort: "cost", dir: "asc", limit: 50, offset: 0 });
    const row = after.sessions.find((s) => s.id === "s-unknown")!;

    expect(row.cost).toBeCloseTo(expectedCosts().get("s-unknown")!, 10);
    expect(row.cost).toBeGreaterThan(0);
    expect(row.unpriced_models).toEqual([]); // it has a rate now
    expect(after.sessions.at(-1)!.id).toBe("s-unknown"); // and is now the dearest session
    // The whole ordering must still agree with the JS path under the override, not just this row.
    expect(after.sessions.map((s) => s.id)).toEqual(expectedOrder("asc"));
  });
});
