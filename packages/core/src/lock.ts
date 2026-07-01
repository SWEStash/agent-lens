/**
 * Cross-platform single-instance lock. collect+ingest take this so a too-frequent schedule (or an
 * overlapping watch trigger) can never run two collectors against the same archive or two writers
 * against the same SQLite DB. systemd already serializes its oneshot; this makes launchd/schtasks/
 * watch safe too. Not a hard mutex (a local, single-user tool doesn't need one) — a stale-aware
 * PID file: a run whose holder is dead or older than `staleMs` is reclaimed.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";

export interface Lock {
  /** Remove the lock file. Idempotent; also runs automatically on process exit. */
  release(): void;
}

function isAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't actually signal
    return true;
  } catch (e) {
    // ESRCH → no such process (dead); EPERM → exists but not ours (alive).
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Try to acquire `lockPath`. Returns a Lock on success, or null if another live, non-stale process
 * currently holds it (caller should log "run in progress" and exit 0).
 */
export function acquireLock(lockPath: string, staleMs = 6 * 60 * 60 * 1000): Lock | null {
  mkdirSync(dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    try {
      const held = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number; ts?: number };
      const fresh = typeof held.ts === "number" && Date.now() - held.ts < staleMs;
      if (fresh && isAlive(held.pid ?? 0)) return null; // held by a live, recent process
      // else: dead PID or too old → reclaim below
    } catch {
      // corrupt lock file → reclaim
    }
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now(), host: hostname() }), { mode: 0o600 });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      // Only remove if it's still ours (avoid deleting a lock a reclaimer took over).
      const cur = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
      if (cur.pid === process.pid) unlinkSync(lockPath);
    } catch {
      /* already gone / unreadable */
    }
  };
  process.once("exit", release);
  return { release };
}
