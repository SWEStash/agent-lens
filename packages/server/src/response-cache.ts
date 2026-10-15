import type { DB } from "./db.js";

/**
 * Memoize read results until the store changes. `PRAGMA data_version` changes whenever another
 * connection commits, and on this read-only handle every write comes from another connection (the
 * ingest timer, or /api/refresh's own ingest handle), so one cheap pragma per request decides
 * staleness. It reads the main schema only: the ATTACHed triage store does not invalidate, so cache
 * nothing that reads triage state. The least recently used entry goes once `max` is reached.
 */
export function dataVersionCache(db: DB, max = 64) {
  const version = db.prepare("PRAGMA data_version");
  const entries = new Map<string, unknown>();
  let seen: unknown;
  return <T>(key: string, compute: () => T): T => {
    const v = (version.get() as { data_version: number }).data_version;
    if (v !== seen) {
      entries.clear();
      seen = v;
    }
    if (entries.has(key)) {
      const hit = entries.get(key) as T;
      entries.delete(key); // re-insert: Map order is the eviction order
      entries.set(key, hit);
      return hit;
    }
    const value = compute();
    entries.set(key, value);
    if (entries.size > max) entries.delete(entries.keys().next().value!);
    return value;
  };
}
