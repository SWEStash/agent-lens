// UI preferences (which charts/columns are shown, per-chart toggles). localStorage is an optimistic
// cache for instant first paint; the server's writable sidecar (/api/prefs) is the source of truth when
// configured, so a choice survives a cache-clear and follows the same server across browsers. Reads:
// paint from localStorage synchronously, then reconcile with the server. Writes: update both. When the
// server has no writable store (or in snapshot mode with no backend), everything degrades to
// localStorage-only with no errors.
import { api, SNAPSHOT } from "./api";

const LS_PREFIX = "agentlens.";

/** Synchronous localStorage read for first paint. Falls back on missing/malformed values. */
export function loadPrefLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Fetch the server-stored value (source of truth). Returns null when unset, no writable store, or
 * unreachable — the caller then keeps whatever it loaded from localStorage. */
export async function fetchPref<T>(key: string): Promise<T | null> {
  if (SNAPSHOT) return null;
  try {
    const r = await api<{ value: T | null }>(`/prefs/${encodeURIComponent(key)}`);
    return r.value ?? null;
  } catch {
    return null;
  }
}

/** Persist a value: write the localStorage cache immediately, then write through to the server
 * best-effort (same-origin PUT → the CSRF Origin check passes; failures are swallowed). */
export function savePref<T>(key: string, value: T): void {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch {
    /* private-mode / disabled storage: keep the in-memory choice for this session */
  }
  if (SNAPSHOT) return;
  void fetch(`/api/prefs/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
  }).catch(() => {});
}
