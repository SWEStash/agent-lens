import { useId, useState } from "react";
import { Link } from "react-router-dom";
import type { Finding } from "../api";
import { SeverityTag, SEVERITIES } from "../severity";

/** One security finding on a tool call (ADR-017): a severity pill + rule title, expandable to the
 * "why" — the matched evidence, the framework anchor, and the detector's context modifiers. Modeled
 * on ClassificationBadge/SignalsPanel so a "why did we flag this" reads the same across the app. */
function FindingBadge({ f }: { f: Finding }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const mods = f.signals?.modifiers ?? {};
  const modKeys = Object.keys(mods).filter((k) => mods[k] !== false && mods[k] != null && mods[k] !== "");
  return (
    <div className={"finding sev-border-" + f.severity}>
      <button className="finding-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
        <SeverityTag severity={f.severity} />
        <span className="finding-title">{f.title ?? f.rule_id}</span>
        {f.framework_ref && <span className="tag framework">{f.framework_ref}</span>}
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="finding-body" id={bodyId}>
          {f.evidence && (
            <div className="code-block">
              <pre className="code finding-evidence">{f.evidence}</pre>
            </div>
          )}
          <dl className="sig-grid">
            <dt>Rule</dt>
            <dd><code>{f.rule_id}</code></dd>
            <dt>Category</dt>
            <dd>{f.category}</dd>
            {modKeys.length > 0 && (
              <>
                <dt>Context</dt>
                <dd>
                  {modKeys.map((k) => (
                    <span key={k} className="sig-chip">
                      {k}
                      {mods[k] !== true ? <span className="muted"> {String(mods[k])}</span> : null}
                    </span>
                  ))}
                </dd>
              </>
            )}
          </dl>
          <Link className="subagent-link small" to={`/security?rule=${encodeURIComponent(f.rule_id)}`}>
            see all “{f.rule_id}” findings →
          </Link>
        </div>
      )}
    </div>
  );
}

/** All security findings on one tool call, most-severe first. Rendered beneath the tool card. */
export function ToolFindings({ findings }: { findings: Finding[] }) {
  if (!findings.length) return null;
  const sorted = [...findings].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  return (
    <div className="tool-findings">
      {sorted.map((f) => (
        <FindingBadge key={f.id} f={f} />
      ))}
    </div>
  );
}

/** Session-level security summary shown in the transcript header: a per-severity count roll-up and a
 * link into the /security page scoped to this session. Leads the reader to the flagged tool calls
 * below (each rendered with its own FindingBadge). */
export function SecurityBanner({ findings, sessionId }: { findings: Finding[]; sessionId: string }) {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  const worst = SEVERITIES.find((s) => counts.has(s)) ?? "info";
  return (
    <div className={"security-banner sev-border-" + worst} role="status">
      <span className="security-banner-icon" aria-hidden="true">🛡</span>
      <span className="security-banner-text">
        {findings.length} security {findings.length === 1 ? "finding" : "findings"} in this session
      </span>
      <span className="security-banner-sevs">
        {SEVERITIES.filter((s) => counts.has(s)).map((s) => (
          <SeverityTag key={s} severity={s} count={counts.get(s)} />
        ))}
      </span>
      <Link className="subagent-link small" to={`/security?session=${encodeURIComponent(sessionId)}`}>
        view on Security page →
      </Link>
    </div>
  );
}
