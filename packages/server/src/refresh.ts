/**
 * `POST /api/refresh` support — the one write-action on an otherwise read-only server (ADR-005).
 * Runs a single collect + ingest pass on the host so the UI can pull in new transcripts on demand,
 * without waiting for the scheduled/`watch` collector. See ADR-015 for the scoped exception.
 *
 * Two guards keep this safe on an unauthenticated loopback server:
 *   - `originAllowed` blocks cross-site CSRF (a web page you visit POSTing to 127.0.0.1).
 *   - the shared single-instance lock stops it racing a scheduled/`watch`/CLI run.
 * The server's own DB handle stays read-only; ingest opens its own short-lived write connection
 * (WAL permits one writer alongside readers), so the read-only invariant of THIS handle holds.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, collectAll, findRepoRoot, resolveDataDir, type CollectStats } from "@agent-lens/core";
import { runIngest } from "@agent-lens/ingest";

export interface RefreshResult {
  ok: true;
  collected: CollectStats;
}

/**
 * CSRF guard for the loopback server. Allow requests with no `Origin` (non-browser callers like curl
 * or the CLI — not a CSRF vector) and same-machine origins; reject anything cross-site. The server
 * already binds loopback only (ADR-005); this stops a page you visit from driving localhost.
 */
export function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const h = new URL(origin).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
}

/**
 * Run one collect + ingest pass under the shared single-instance lock. Returns `null` if a run is
 * already in progress (caller → 409). Throws on collect/ingest failure (caller → 500). Synchronous
 * and blocking: on a large archive this briefly stalls the server, acceptable for a local
 * single-user tool (the clicking user is waiting on it anyway).
 */
export function runRefresh(): RefreshResult | null {
  const dataDir = resolveDataDir(findRepoRoot());
  const lock = acquireLock(join(dataDir, ".agent-lens.lock"));
  if (!lock) return null;
  try {
    const collected = collectAll();
    // runIngest process.exit(1)s if the archive dir is missing — which would kill the server. Ensure
    // it exists first (collectAll creates it when there's anything to copy; this covers the empty case).
    const archiveRoot = process.env.AGENT_LENS_ARCHIVE || join(dataDir, "archive");
    if (!existsSync(archiveRoot)) mkdirSync(archiveRoot, { recursive: true });
    runIngest([]);
    return { ok: true, collected };
  } finally {
    lock.release();
  }
}
