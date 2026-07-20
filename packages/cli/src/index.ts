/**
 * `agent-lens` — the unified CLI. One binary dispatching the pipeline: collect → ingest → serve,
 * plus watch (resident collect+ingest) and service (install collect+ingest and/or serve as OS
 * services). Bundled into a single file by tsup so it installs as one npm package (ADR-010).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cac } from "cac";
import {
  acquireLock,
  collectAll,
  findRepoRoot,
  loadSources,
  parseHours,
  parseTargets,
  resolveConfigFile,
  resolveDataDir,
  resolveDbPath,
  resolveServerConfig,
  runService,
} from "@agent-lens/core";
import { runIngest, runMetrics } from "@agent-lens/ingest";
import { startServer, openReadonly, renderSessionExport, parseRedactionLevel } from "@agent-lens/server";
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
  .option("--db <path>", "SQLite DB path (overrides AGENT_LENS_DB / config db)")
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
  .option("--port <n>", "HTTP port (overrides AGENT_LENS_PORT / config server.port; default 4477)")
  .option("--host <host>", "Bind host (overrides AGENT_LENS_HOST / config server.host; loopback only unless AGENT_LENS_ALLOW_NONLOCAL=1)")
  .option("--db <path>", "SQLite DB path (overrides AGENT_LENS_DB / config db)")
  .action(async (opts: { port?: string; host?: string; db?: string }) => {
    try {
      await startServer({ port: opts.port, host: opts.host, db: opts.db });
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
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
  .option("--db <path>", "SQLite DB path (overrides AGENT_LENS_DB / config db)")
  .action((opts: { db?: string }) => {
    runMetrics(opts.db ? ["--db", opts.db] : []);
  });

cli
  .command("export <sessionId>", "Write a session to a shareable Markdown file (redacted by default)")
  .option("--out <file>", "Write to this file (default: stdout)")
  .option("--level <level>", "Redaction level: secrets (default) | structure")
  .option("--no-redact", "Verbatim, UNREDACTED output (opt-out)")
  .option("--db <path>", "SQLite DB path (overrides AGENT_LENS_DB / config db)")
  .action((sessionId: string, opts: { out?: string; level?: string; redact?: boolean; db?: string }) => {
    const { path: dbPath } = resolveDbPath(opts.db);
    if (!existsSync(dbPath)) {
      console.error(`agent-lens: db not found: ${dbPath} (run ingest first)`);
      process.exit(1);
    }
    // cac sets `redact:false` for --no-redact. Otherwise the level flag (default: secrets).
    const level = opts.redact === false ? "off" : parseRedactionLevel(opts.level);
    const out = renderSessionExport(openReadonly(dbPath), sessionId, level);
    if (!out) {
      console.error(`agent-lens: session not found: ${sessionId}`);
      process.exit(1);
    }
    if (opts.out) {
      writeFileSync(opts.out, out.markdown);
      console.error(`agent-lens: wrote ${out.filename} → ${opts.out} (redaction: ${level})`);
    } else {
      process.stdout.write(out.markdown);
    }
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

cli
  .command("config", "Show the effective configuration (sources, paths, server) and where each value came from")
  .action(() => {
    const repoRoot = findRepoRoot();
    const dataDir = resolveDataDir(repoRoot);
    const configFile = resolveConfigFile(repoRoot, dataDir);
    let server;
    try {
      server = resolveServerConfig();
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    const { port, host, portOrigin, hostOrigin } = server;
    const { path: dbPath, origin: dbOrigin } = resolveDbPath();
    const archive = process.env.AGENT_LENS_ARCHIVE || join(dataDir, "archive");
    const triageDb = process.env.AGENT_LENS_TRIAGE_DB || join(dirname(dbPath), "triage.db");
    const keepDays = process.env.AGENT_LENS_VERSIONS_KEEP_DAYS || "90";
    const keepOrigin = process.env.AGENT_LENS_VERSIONS_KEEP_DAYS ? "env" : "default";

    console.log("agent-lens config (precedence: flag > env > config file > default)\n");
    console.log("Paths");
    console.log(`  config file      ${configFile ?? "(none — using built-in default source)"}`);
    console.log(`  data dir         ${dataDir}${process.env.AGENT_LENS_DATA ? "  [env]" : ""}`);
    console.log(`  archive          ${archive}${process.env.AGENT_LENS_ARCHIVE ? "  [env]" : ""}`);
    console.log(`  db               ${dbPath}  [${dbOrigin}]`);
    console.log(`  triage db        ${triageDb}${process.env.AGENT_LENS_TRIAGE_DB ? "  [env]" : ""}`);
    console.log("\nServer");
    console.log(`  host             ${host}  [${hostOrigin}]`);
    console.log(`  port             ${port}  [${portOrigin}]`);
    console.log(`  non-local bind   ${process.env.AGENT_LENS_ALLOW_NONLOCAL ? "allowed (AGENT_LENS_ALLOW_NONLOCAL)" : "blocked (loopback only)"}`);
    console.log("\nRetention");
    console.log(`  .versions keep   ${keepDays} day(s)  [${keepOrigin}]`);
    console.log("\nSources");
    for (const s of loadSources()) console.log(`  ${s.label.padEnd(14)} ${s.configDir}  (${s.agent})`);
  });

cli.help();
cli.version(version());
cli.parse();
