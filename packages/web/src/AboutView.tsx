/**
 * /about — diagnostics (ADR-027). The web mirror of `agent-lens config`, plus versions and storage.
 *
 * Read-only on purpose. Configuration resolves flag > env > config file > default, so an editor here
 * could only ever write the third layer and would silently do nothing for anyone using env vars —
 * so every value shows *where it came from* instead of offering to change it.
 *
 * Never rendered in snapshot mode: /api/about is deliberately not exported (it carries absolute
 * filesystem paths, and the snapshot is published publicly). The route is gated in main.tsx.
 */
import { useFetch } from "./useFetch";
import { AsyncBoundary } from "./AsyncBoundary";
import { BUILD_VERSION } from "./buildInfo";
import type { AboutResponse, EngineVersion, PathInfo } from "./api";

/** 1.2 GB / 903 MB / 12 kB — SI units, matching how disk sizes are reported elsewhere. */
function bytes(n: number | null): string {
  if (n == null) return "unknown";
  if (n < 1000) return `${n} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{children}</td>
    </tr>
  );
}

/** A resolved path plus the layer it came from — `fixed` means not independently relocatable. */
function PathCell({ info }: { info: PathInfo }) {
  return (
    <>
      <code className="path">{info.path}</code>{" "}
      <span className="origin-tag" title={originHelp(info.origin)}>
        {info.origin}
      </span>
    </>
  );
}

function originHelp(origin: PathInfo["origin"]): string {
  switch (origin) {
    case "env":
      return "Set by an environment variable";
    case "flag":
      return "Set by a command-line flag";
    case "file":
      return "Set in the config file";
    case "fixed":
      return "Not independently relocatable — move the whole data dir (ADR-021)";
    default:
      return "Built-in default";
  }
}

/**
 * A stamped engine: what this build produces, against what actually produced the stored rows.
 * Showing only the build number would answer the less useful question — the point is whether your
 * data predates the rules this build has, which is exactly when a re-run is worth doing.
 */
function Engine({ label, v, what, rerun }: { label: string; v: EngineVersion; what: string; rerun: string }) {
  const older = v.in_data.filter((n) => n < v.expected);
  return (
    <Row label={label}>
      v{v.expected}
      {v.stale && <> <span className="warn-tag">data is older</span></>}
      <div className="muted">
        {v.in_data.length === 0 ? (
          <>No {what} stored yet.</>
        ) : v.stale ? (
          <>
            Stored {what} came from v{older.join(", v")} — re-run <code>{rerun}</code> to relabel with v
            {v.expected}.
          </>
        ) : (
          <>All stored {what} came from v{v.in_data.join(", v")}.</>
        )}
      </div>
    </Row>
  );
}

export default function AboutView() {
  const state = useFetch<AboutResponse>("/about");

  return (
    <div className="about">
      <h1>About</h1>
      <p className="muted">
        Diagnostics for this install. Configuration is shown read-only — it resolves{" "}
        <code>flag &gt; env &gt; config file &gt; default</code>, so change it with{" "}
        <code>agent-lens config</code>, an env var, or the config file.
      </p>

      <AsyncBoundary state={state}>
        {(a) => (
          <>
            <section>
              <h2>Versions</h2>
              <table className="kv">
                <tbody>
                  <Row label="Agent Lens">
                    {a.versions.app} <span className="origin-tag">{a.versions.app_source}</span>
                    {a.versions.app_source === "unknown" && (
                      <span className="muted">
                        {" "}
                        — no npm metadata and no git tag reachable; this is an unreleased or archive build
                      </span>
                    )}
                  </Row>
                  {BUILD_VERSION !== a.versions.app && (
                    <Row label="Web build">
                      {BUILD_VERSION}{" "}
                      <span className="warn-tag" role="status">
                        differs from the server
                      </span>
                      <div className="muted">
                        The page you are looking at was built from a different revision than the server
                        serving it — usually a service still running an older install. Restart it, or
                        rebuild the UI.
                      </div>
                    </Row>
                  )}
                  <Row label="Schema">
                    {a.versions.schema ?? "unstamped"}
                    {a.versions.schema_stale && (
                      <>
                        {" "}
                        <span className="warn-tag">stale</span>
                        <div className="muted">
                          Written by an older build (this one expects {a.versions.schema_expected}). Run{" "}
                          <code>agent-lens ingest --full</code>.
                        </div>
                      </>
                    )}
                  </Row>
                  <Engine
                    label="Detector"
                    v={a.versions.detector}
                    what="security findings"
                    rerun="agent-lens ingest --full"
                  />
                  <Engine
                    label="Classifier"
                    v={a.versions.classifier}
                    what="session categories"
                    rerun="agent-lens metrics"
                  />
                </tbody>
              </table>
            </section>

            <section>
              <h2>Paths</h2>
              <table className="kv">
                <tbody>
                  <Row label="Config file">
                    {a.paths.config_file ? <code className="path">{a.paths.config_file}</code> : <span className="muted">none — using built-in defaults</span>}
                  </Row>
                  <Row label="Data dir"><PathCell info={a.paths.data_dir} /></Row>
                  <Row label="Archive"><PathCell info={a.paths.archive} /></Row>
                  <Row label="Database"><PathCell info={a.paths.db} /></Row>
                  <Row label="Triage store"><PathCell info={a.paths.triage_db} /></Row>
                </tbody>
              </table>
            </section>

            <section>
              <h2>Server</h2>
              <table className="kv">
                <tbody>
                  <Row label="Bound to">
                    <code>
                      {a.server.host}:{a.server.port}
                    </code>
                  </Row>
                  <Row label="Network">
                    {a.server.loopback_only ? (
                      "Loopback only — not reachable from other machines"
                    ) : (
                      <>
                        <span className="warn-tag">non-loopback bind</span>
                        <div className="muted">
                          Reachable from other machines on this network. The API is unauthenticated.
                        </div>
                      </>
                    )}
                  </Row>
                </tbody>
              </table>
            </section>

            <section>
              <h2>Retention</h2>
              <table className="kv">
                <tbody>
                  <Row label="Keep .versions">
                    {a.retention.versions_keep_days} day{a.retention.versions_keep_days === 1 ? "" : "s"}{" "}
                    <span className="origin-tag" title={originHelp(a.retention.origin)}>
                      {a.retention.origin}
                    </span>
                    <div className="muted">
                      How long superseded transcript snapshots are kept before <code>scripts/prune.sh</code>{" "}
                      removes them. Does not affect the database.
                    </div>
                  </Row>
                </tbody>
              </table>
            </section>

            <section>
              <h2>Pricing</h2>
              <table className="kv">
                <tbody>
                  <Row label="Models priced">
                    {a.pricing.models}{" "}
                    <span className="origin-tag" title={originHelp(a.pricing.origin)}>
                      {a.pricing.origin}
                    </span>
                    <div className="muted">
                      Cost is estimated from token counts at API list prices — never read from the
                      transcripts, which do not record it. Override or add rates with a{" "}
                      <code>pricing</code> block in the config file.
                    </div>
                  </Row>
                  {a.pricing.applied.length > 0 && (
                    <Row label="Overrides">
                      {a.pricing.applied.map((m) => (
                        <code key={m} className="path">
                          {m}
                        </code>
                      ))}
                    </Row>
                  )}
                  {a.pricing.invalid.length > 0 && (
                    <Row label="Ignored">
                      <span className="warn-tag">malformed</span>{" "}
                      {a.pricing.invalid.map((m) => (
                        <code key={m} className="path">
                          {m}
                        </code>
                      ))}
                      <div className="muted">
                        Each entry needs numeric <code>input</code> and <code>output</code> rates. These
                        kept their built-in rate.
                      </div>
                    </Row>
                  )}
                  <Row label="Unpriced models">
                    {a.pricing.unpriced.length === 0 ? (
                      <span className="muted">None — every model in this store has a rate</span>
                    ) : (
                      <>
                        <span className="warn-tag" role="status">
                          cost understated
                        </span>{" "}
                        {a.pricing.unpriced.map((m) => (
                          <code key={m} className="path">
                            {m}
                          </code>
                        ))}
                        <div className="muted">
                          These have token usage but no rate, so they contribute $0 to every cost shown.
                          Upgrade for an updated table, or add rates under <code>pricing</code> in the
                          config file.
                        </div>
                      </>
                    )}
                  </Row>
                </tbody>
              </table>
            </section>

            <section>
              <h2>Sources</h2>
              {a.sources.length === 0 ? (
                <p className="muted">No sources configured.</p>
              ) : (
                <table className="kv">
                  <tbody>
                    {a.sources.map((s) => (
                      <Row key={s.label} label={s.label}>
                        <code className="path">{s.config_dir}</code> <span className="origin-tag">{s.agent}</span>
                      </Row>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section>
              <h2>Storage</h2>
              <table className="kv">
                <tbody>
                  <Row label="Database">{bytes(a.storage.db_bytes)}</Row>
                  <Row label="Ingested">
                    {bytes(a.storage.archive_bytes)} across {a.storage.archive_files.toLocaleString()} file
                    {a.storage.archive_files === 1 ? "" : "s"}
                    <div className="muted">
                      Transcript bytes read into the database
                      {a.storage.last_ingested ? `, as of the last ingest (${new Date(a.storage.last_ingested).toLocaleString()})` : ""}.
                      Excludes anything in the archive that has not been ingested, such as{" "}
                      <code>.versions/</code> retention snapshots — so it is not the archive folder&rsquo;s
                      size on disk.
                    </div>
                  </Row>
                </tbody>
              </table>
            </section>
          </>
        )}
      </AsyncBoundary>
    </div>
  );
}
