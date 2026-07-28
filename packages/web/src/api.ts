// Snapshot mode: when built with VITE_SNAPSHOT=1 the SPA is a static, read-only bundle (e.g. GitHub
// Pages) with no live API — each endpoint's default response was pre-exported to
// `<base>/snapshot/<path>.json` by scripts/export-snapshot.mjs. Query params (filters, pagination)
// are stripped, so the snapshot always serves the default unfiltered view.
export const SNAPSHOT = (import.meta as any).env?.VITE_SNAPSHOT === "1";
const BASE = (import.meta as any).env?.BASE_URL ?? "/";

function resolveUrl(path: string): string {
  if (!SNAPSHOT) return "/api" + path;
  const [rawPath, rawQuery] = path.split("?");
  const clean = rawPath.replace(/^\//, ""); // drop query + leading slash → snapshot key
  // The file-provenance timeline (/file) is per-file but keyed by query params (the file path
  // contains slashes, so it can't be a route segment). Unlike the list endpoints it must NOT collapse
  // to a single default file — map each (path, project) to its own snapshot via a stable hash that
  // scripts/export-snapshot.mjs mirrors.
  if (clean === "file") {
    const p = new URLSearchParams(rawQuery ?? "");
    return `${BASE}snapshot/file/${snapshotFileKey(p.get("path") ?? "", p.get("project"))}.json`;
  }
  return `${BASE}snapshot/${clean}.json`;
}

/**
 * Stable snapshot key for a file's provenance timeline (/file). The file path contains slashes and
 * can be long, so it can't be a filename directly — hash (project, path) with cyrb53 to a short,
 * filesystem-safe token. scripts/export-snapshot.mjs computes the IDENTICAL key when it writes
 * snapshot/file/<key>.json — KEEP THE TWO IN SYNC (change one, change the other).
 */
export function snapshotFileKey(path: string, project?: string | null): string {
  const s = `${project ?? ""}\n${path}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** URL for a session's Markdown export — the live API route, or the pre-rendered static file in
 * snapshot mode. `level` picks the redaction mode: default (undefined) = the server's redacted
 * `secrets` level; `structure` = aggressive scrub; `off` = verbatim. Snapshot mode serves the one
 * pre-rendered (redacted) file regardless. */
export function exportUrl(id: string, level?: "structure" | "off"): string {
  if (SNAPSHOT) return `${BASE}snapshot/sessions/${id}.export.md`;
  return `/api/sessions/${id}/export.md${level ? `?redact=${level}` : ""}`;
}

export async function api<T = any>(path: string): Promise<T> {
  const r = await fetch(resolveUrl(path));
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

/** POST to a live API route (never used in snapshot mode — there is no backend). Same-origin, so the
 * browser sends the Origin header the server's CSRF guard checks; no custom header (avoids preflight). */
export async function apiPost<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await fetch("/api" + path, {
    method: "POST",
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}


// The API response contracts live in @agent-lens/contracts, shared with the server so a renamed
// field is a compile error on both sides (ADR-026). They are re-exported here because every view
// already imports its types from "./api" alongside `api()` — keeping that one import surface is why
// this module still names them, even though it no longer declares them.
export type * from "@agent-lens/contracts";
