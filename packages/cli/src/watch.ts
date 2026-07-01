/**
 * `agent-lens watch` — a resident process that collects + ingests whenever a source's transcripts
 * change (debounced), and optionally on a fixed interval. This is the Node-native periodic option;
 * `agent-lens service install collector` layers OS-level persistence (reboot survival) on top.
 *
 * Overlap safety: an in-process guard collapses a burst of file events into one cycle and never runs
 * two cycles at once; the shared single-instance lock additionally guards against a scheduled run
 * firing concurrently.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import chokidar from "chokidar";
import { acquireLock, collectAll, findRepoRoot, loadSources, resolveDataDir, type Source } from "@agent-lens/core";
import { runIngest } from "@agent-lens/ingest";

export interface WatchOptions {
  intervalSec?: number;
  poll?: boolean;
}

export async function runWatch(opts: WatchOptions = {}): Promise<void> {
  const sources: Source[] = loadSources();
  const lockPath = join(resolveDataDir(findRepoRoot()), ".agent-lens.lock");

  let running = false;
  let pending = false;
  const cycle = () => {
    if (running) {
      pending = true; // a change arrived mid-cycle — run once more when this finishes
      return;
    }
    running = true;
    const lock = acquireLock(lockPath);
    if (!lock) {
      running = false;
      console.error("agent-lens watch: another collect/ingest run is in progress — skipping this cycle");
      return;
    }
    try {
      const stats = collectAll({ sources });
      console.log(
        `agent-lens watch: collected ${stats.scanned} files (${stats.appended} appended, ${stats.snapshots} snapshots) — ingesting`,
      );
      runIngest([]);
    } catch (e) {
      console.error("agent-lens watch: cycle failed:", e);
    } finally {
      lock.release();
      running = false;
      if (pending) {
        pending = false;
        setTimeout(cycle, 0);
      }
    }
  };

  cycle(); // initial catch-up

  const watchPaths = sources.map((s) => join(s.configDir, "projects")).filter((p) => existsSync(p));
  if (watchPaths.length === 0) {
    console.error("agent-lens watch: no source 'projects' directories found — nothing to watch");
  }
  const watcher = chokidar.watch(watchPaths, {
    ignoreInitial: true,
    usePolling: !!opts.poll,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });
  let debounce: NodeJS.Timeout | null = null;
  const trigger = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(cycle, 3000); // coalesce bursts of writes into one cycle
  };
  watcher.on("add", trigger).on("change", trigger);

  if (opts.intervalSec && opts.intervalSec > 0) {
    setInterval(cycle, opts.intervalSec * 1000);
  }

  console.log(
    `agent-lens watch: watching ${watchPaths.length} source dir(s)` +
      (opts.intervalSec ? ` + every ${opts.intervalSec}s` : "") +
      " — Ctrl-C to stop",
  );
  // Keep the process alive indefinitely (chokidar + timers hold it open, but be explicit).
  return new Promise<void>(() => {});
}
