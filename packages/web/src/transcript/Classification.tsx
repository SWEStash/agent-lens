import { useId, useState } from "react";
import type { Classification, ClassificationSignals } from "../api";

export function ClassificationBadge({ c }: { c: Classification }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const loc = c.signals?.loc;
  return (
    <div className="classification">
      <span className={"tag cat cat-" + (c.category ?? "none")}>{c.category ?? "unclassified"}</span>
      {c.complexity_band && (
        <span className="tag complexity">
          {c.complexity_band} · {c.complexity_score}
        </span>
      )}
      {loc && (
        <span className="muted small">
          +{loc.added}/−{loc.removed} LoC · {loc.files} files
        </span>
      )}
      <button className="ghost small" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
        why {open ? "▾" : "▸"}
      </button>
      {open &&
        (c.signals ? (
          <SignalsPanel id={panelId} s={c.signals} category={c.category} />
        ) : (
          <div id={panelId} className="muted small pad">No signals recorded for this session.</div>
        ))}
    </div>
  );
}

const FACTOR_LABEL: Record<string, string> = {
  loc: "Lines changed",
  files: "Files touched",
  turns: "Turns",
  tokens: "Work tokens",
  duration: "Duration",
  subagents: "Subagents",
};

const pct = (x: number) => `${Math.max(0, Math.min(1, x)) * 100}%`;

/** Sorted "name ×count" chips from a counts map (e.g. tool or skill mix). */
function CountChips({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return <span className="muted">—</span>;
  return (
    <span className="sig-chips">
      {entries.map(([name, n]) => (
        <span key={name} className="sig-chip">
          {name} <span className="muted">×{n}</span>
        </span>
      ))}
    </span>
  );
}

/** A friendly explainer for the classifier's `signals` blob: it turns the raw evidence into the
 * story behind the two badges — what built the complexity score, why this category won, and the
 * underlying measurements — with the raw JSON still one click away for debugging/retuning. */
function SignalsPanel({ id, s, category }: { id: string; s: ClassificationSignals; category: string | null }) {
  const [raw, setRaw] = useState(false);
  const rawId = useId();

  // Complexity score = Σ (weight × subscore) × 100. Show each factor's point contribution, biggest first.
  const weights = s.complexity_weights ?? {};
  const subscores = s.complexity_subscores ?? {};
  const contributions = Object.keys(weights)
    .map((k) => ({ key: k, weight: weights[k], subscore: subscores[k] ?? 0, pts: weights[k] * (subscores[k] ?? 0) * 100 }))
    .sort((a, b) => b.pts - a.pts);
  const maxPts = Math.max(...contributions.map((c) => c.pts), 0.0001);

  // Category is the argmax of these scores; rank them so the runner-up is visible too.
  const cats = Object.entries(s.category_scores ?? {})
    .map(([k, v]) => ({ k, v }))
    .sort((a, b) => b.v - a.v);
  const maxCat = Math.max(...cats.map((c) => c.v), 0.0001);
  const visibleCats = cats.filter((c) => c.v > 0.02 || c.k === category);

  const hasSkills = s.skills && Object.keys(s.skills).length > 0;

  return (
    <div id={id} className="signals-panel">
      {contributions.length > 0 && (
        <section className="sig-section">
          <h4 className="sig-h">
            Complexity breakdown <span className="muted">— what built the score</span>
          </h4>
          <ul className="sig-bars">
            {contributions.map((c) => (
              <li key={c.key} className="sig-bar-row">
                <span className="sig-bar-label">{FACTOR_LABEL[c.key] ?? c.key}</span>
                <span className="sig-bar" aria-hidden="true">
                  <span className="sig-bar-fill" style={{ width: pct(c.pts / maxPts) }} />
                </span>
                <span className="sig-bar-val">{c.pts.toFixed(1)} pts</span>
                <span className="sig-bar-sub muted">
                  {Math.round(c.subscore * 100)}% intensity · weight {Math.round(c.weight * 100)}%
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {visibleCats.length > 0 && (
        <section className="sig-section">
          <h4 className="sig-h">
            Category scores <span className="muted">— why “{category}” won</span>
          </h4>
          <ul className="sig-bars">
            {visibleCats.map((c) => (
              <li key={c.k} className={"sig-bar-row" + (c.k === category ? " is-win" : "")}>
                <span className="sig-bar-label">{c.k}</span>
                <span className="sig-bar" aria-hidden="true">
                  <span className="sig-bar-fill" style={{ width: pct(c.v / maxCat) }} />
                </span>
                <span className="sig-bar-val">{c.v.toFixed(2)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="sig-section">
        <h4 className="sig-h">Evidence</h4>
        <dl className="sig-grid">
          {s.tool_counts && (
            <>
              <dt>Tools</dt>
              <dd>
                <CountChips counts={s.tool_counts} />
              </dd>
            </>
          )}
          {hasSkills && (
            <>
              <dt>Skills</dt>
              <dd>
                <CountChips counts={s.skills!} />
              </dd>
            </>
          )}
          {s.subagent_role && (
            <>
              <dt>Subagent role</dt>
              <dd>{s.subagent_role}</dd>
            </>
          )}
          {s.files && s.files.length > 0 && (
            <>
              <dt>Files ({s.files.length})</dt>
              <dd className="sig-files">{s.files.join(", ")}</dd>
            </>
          )}
        </dl>
      </section>

      <button className="ghost small" aria-expanded={raw} aria-controls={rawId} onClick={() => setRaw((r) => !r)}>
        {raw ? "Hide raw JSON ▴" : "View raw JSON ▾"}
      </button>
      {raw && (
        <pre id={rawId} className="code signals">
          {JSON.stringify(s, null, 2)}
        </pre>
      )}
    </div>
  );
}
