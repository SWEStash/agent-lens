/** The PRs and pushed branches a session recorded (ADR-041), for the header's meta row. Each PR links
 * out to its page when a URL was recorded, and to the other sessions that touched it. */
import { Link } from "react-router-dom";
import { SNAPSHOT, type SessionBranch, type SessionPr } from "../api";

/** The `?pr=` value that finds a PR's sessions: its URL when known, else `owner/repo#n`. */
export function prQuery(p: SessionPr): string {
  return p.url ?? `${p.repository}#${p.number}`;
}

export function GitLinks({ prs, branches }: { prs?: SessionPr[]; branches?: SessionBranch[] }) {
  if (!prs?.length && !branches?.length) return null;
  return (
    <>
      {prs?.length ? (
        <span className="spawned-by">
          PR{" "}
          {prs.map((p, i) => {
            const label = `${p.repository}#${p.number}`;
            return (
              <span key={label}>
                {i > 0 && ", "}
                {p.url ? (
                  <a href={p.url} target="_blank" rel="noopener noreferrer">{label}</a>
                ) : (
                  label
                )}
                {p.opened_here && <span className="tag meta-type">opened</span>}
                {/* The snapshot serves every list unfiltered, so a filter link there would mislead. */}
                {!SNAPSHOT && (
                  <>
                    {" "}
                    <Link
                      to={`/?pr=${encodeURIComponent(prQuery(p))}`}
                      aria-label={`Sessions that touched ${label}`}
                      data-tip="Sessions that touched this PR"
                    >
                      sessions
                    </Link>
                  </>
                )}
              </span>
            );
          })}
        </span>
      ) : null}
      {branches?.length ? (
        <span className="spawned-by">
          pushed{" "}
          {branches.map((b) => (
            <span key={b.branch} className="tag meta-type">{b.branch}</span>
          ))}
        </span>
      ) : null}
    </>
  );
}
