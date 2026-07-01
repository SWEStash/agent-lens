/**
 * `agent-lens` — the unified CLI. One binary dispatching the pipeline: collect → ingest → serve,
 * plus watch (resident collect+ingest) and service (install collect+ingest and/or serve as OS
 * services). Bundled into a single file by tsup so it installs as one npm package (ADR-010).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cac } from "cac";
import { acquireLock, collectAll, findRepoRoot, parseHours, parseTargets, resolveDataDir, runService } from "@agent-lens/core";
import { runIngest, runMetrics } from "@agent-lens/ingest";
import { startServer } from "@agent-lens/server";
import { runWatch } from "./watch.js";

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Run `fn` under the single-instance lock so collect/ingest never overlap another run. */
function withLock(fn: () => void): void {
  const lockPath = join(resolveDataDir(findRepoRoot()), ".agent-lens.lock");
  const lock = acquireLock(lockPath);
  if (!lock) {
    console.error("agent-lens: another collect/ingest run is in progress — skipping");
    return;
  }
  try {
    fn();
  } finally {
    lock.release();
  }
}

const cli = cac("agent-lens");

cli
  .command("collect", "Copy new session traces into the local archive")
  .option("--then-ingest", "Run ingest immediately after collecting")
  .action((opts: { thenIngest?: boolean }) => {
    withLock(() => {
      const s = collectAll();
      console.log(
        `agent-lens: collect done — ${s.sources} source(s), ${s.scanned} scanned, ${s.copied} copied, ` +
          `${s.appended} appended, ${s.diverged} diverged, ${s.compacted} compacted, ${s.snapshots} snapshots`,
      );
      if (opts.thenIngest) runIngest([]);
    });
  });

cli
  .command("ingest", "Build/update the SQLite projection from the archive")
  .option("--full", "Ignore incremental state and re-read every file")
  .option("--db <path>", "SQLite DB path")
  .option("--archive <path>", "Archive directory")
  .action((opts: { full?: boolean; db?: string; archive?: string }) => {
    const argv: string[] = [];
    if (opts.full) argv.push("--full");
    if (opts.db) argv.push("--db", opts.db);
    if (opts.archive) argv.push("--archive", opts.archive);
    withLock(() => runIngest(argv));
  });

cli
  .command("serve", "Serve the web UI + read-only API on 127.0.0.1")
  .action(async () => {
    await startServer();
  });

cli
  .command("watch", "Watch sources and collect + ingest on change (resident process)")
  .option("--interval <sec>", "Also run on a fixed interval (seconds)")
  .option("--poll", "Use polling — for network filesystems where fs events don't fire")
  .action(async (opts: { interval?: string; poll?: boolean }) => {
    await runWatch({ intervalSec: opts.interval ? Number(opts.interval) : undefined, poll: !!opts.poll });
  });

cli
  .command("metrics", "Re-run classification over an already-ingested DB")
  .option("--db <path>", "SQLite DB path")
  .action((opts: { db?: string }) => {
    runMetrics(opts.db ? ["--db", opts.db] : []);
  });

cli
  .command(
    "service <action> [target]",
    "Install/uninstall/status OS services — action: install|uninstall|status; target: collector|server|all (default all)",
  )
  .option("--times <hours>", "Collector cadence: comma-separated hours 0-23 (default: 9,13,17,21)")
  .action((action: string, target: string | undefined, opts: { times?: string }) => {
    const targets = parseTargets(target);
    const hours = action === "install" ? parseHours(opts.times) : undefined;
    // The bundled CLI file is this module; bake its absolute path + node into every unit/plist/task.
    runService(action, { cliEntry: fileURLToPath(import.meta.url), hours, targets });
  });

cli.help();
cli.version(version());
cli.parse();
