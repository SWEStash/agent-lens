import { createContext, Fragment, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, exportUrl, type Classification, type ClassificationSignals, type EventNode, type FileChangeRow, type Finding, type SessionChild, type SessionDetail, type ToolCall } from "./api";
import { fmtCost, fmtDate, fmtDuration, fmtTokens, shortModel, tokenSplitTitle } from "./format";
import { prettyJson } from "./jsonish";
import { SeverityTag, SEVERITIES } from "./severity";
import CopyButton from "./CopyButton";
import { useDetailsAutoClose } from "./useDetailsAutoClose";

/** How message bodies render: "markdown" (formatted, the default) or "raw" (verbatim text).
 * Provided once per SessionView and consumed deep in the tree by message bodies. */
export type MsgFormat = "markdown" | "raw";
const FormatContext = createContext<MsgFormat>("markdown");

/** Export-to-Markdown control. A <details> menu (shares the `.col-customizer`/`.col-menu` styles)
 * offering the redacted default, an aggressive structure-only scrub, and an explicit verbatim
 * opt-out. Redaction is best-effort — the exported file carries that disclaimer. */
function ExportMenu({ id }: { id: string }) {
  const ref = useDetailsAutoClose();
  return (
    <details className="export-menu col-customizer" ref={ref}>
      <summary className="export" title="Export this session as Markdown">⬇ Export Markdown</summary>
      <div className="col-menu" role="group" aria-label="Export options">
        <a href={exportUrl(id)} download>Redacted <span className="muted small">(secrets masked)</span></a>
        <a href={exportUrl(id, "structure")} download>Structure only <span className="muted small">(scrubbed)</span></a>
        <a className="export-verbatim" href={exportUrl(id, "off")} download>Verbatim <span className="muted small">(unredacted)</span></a>
      </div>
    </details>
  );
}

/** Maps a Workflow tool_use id → its run id (wf_…), built once per SessionView from the transcript's
 * tool calls. Lets a `<task-notification>` (which carries the originating tool-use-id) link straight
 * to the workflow detail page. Tasks with no matching Workflow tool_call (e.g. a plain Agent spawn)
 * just won't resolve a link. */
const WorkflowMapContext = createContext<Map<string, string>>(new Map());

/** When true, mechanical tool-call chips (Bash, Edit, Skill, Read, …) are hidden so the transcript
 * reads as just the human-facing conversation. Plans and AskUserQuestion Q&A are kept regardless —
 * they're part of that conversation, not tool noise. */
const HideToolsContext = createContext<boolean>(false);
// event uuid of a deep-linked message to flash (from #ev-<uuid>); null = none. Owned by SessionView so
// the highlight survives re-renders (e.g. expanding the target's turn).
const FlashContext = createContext<string | null>(null);

const FORMAT_KEY = "agentlens.msgFormat";
function loadFormat(): MsgFormat {
  try {
    return localStorage.getItem(FORMAT_KEY) === "raw" ? "raw" : "markdown";
  } catch {
    return "markdown";
  }
}

const HIDE_TOOLS_KEY = "agentlens.hideTools";
function loadHideTools(): boolean {
  try {
    return localStorage.getItem(HIDE_TOOLS_KEY) === "1";
  } catch {
    return false;
  }
}

function ClassificationBadge({ c }: { c: Classification }) {
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
function ToolFindings({ findings }: { findings: Finding[] }) {
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
function SecurityBanner({ findings, sessionId }: { findings: Finding[]; sessionId: string }) {
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

/** One node of the files-changed tree: subdirectories + the files sitting directly in it. */
interface FileTreeNode {
  dirs: Map<string, FileTreeNode>;
  files: Array<{ name: string; path: string; list: FileChangeRow[] }>;
}

/** Build a directory tree from per-file change lists (display paths), then compress single-child
 * directory chains (`src` → `components` with nothing else becomes one `src/components` row) so the
 * tree stays shallow. Out-of-project files keep their absolute path — their leading `/` segment
 * makes them visibly absolute in the tree. */
function buildFileTree(entries: Array<{ display: string; path: string; list: FileChangeRow[] }>): FileTreeNode {
  const root: FileTreeNode = { dirs: new Map(), files: [] };
  for (const e of entries) {
    const abs = e.display.startsWith("/");
    const segs = (abs ? e.display.slice(1) : e.display).split("/");
    if (abs && segs.length > 0) segs[0] = "/" + segs[0];
    let node = root;
    for (const seg of segs.slice(0, -1)) {
      node = node.dirs.get(seg) ?? node.dirs.set(seg, { dirs: new Map(), files: [] }).get(seg)!;
    }
    node.files.push({ name: segs[segs.length - 1], path: e.path, list: e.list });
  }
  const compress = (node: FileTreeNode) => {
    for (const [name, child] of [...node.dirs.entries()]) {
      compress(child);
      if (child.files.length === 0 && child.dirs.size === 1) {
        const [subName, sub] = [...child.dirs.entries()][0];
        node.dirs.delete(name);
        node.dirs.set(name + "/" + subName, sub);
      }
    }
  };
  compress(root);
  return root;
}

/** Render a tree node as indented table rows: directory rows span the table; file rows keep the
 * jump link, change summary, and history link. Dirs first, then files, both alphabetical. */
function FileTreeRows({ node, depth }: { node: FileTreeNode; depth: number }) {
  const indent = { paddingLeft: `${0.4 + depth * 1.1}rem` };
  return (
    <>
      {[...node.dirs.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, child]) => (
          <Fragment key={name}>
            <tr>
              <td colSpan={3} style={indent}>
                <span className="muted">📁 {name}/</span>
              </td>
            </tr>
            <FileTreeRows node={child} depth={depth + 1} />
          </Fragment>
        ))}
      {[...node.files]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((f) => {
          const first = f.list.find((c) => c.event_uuid);
          const added = f.list.reduce((a, c) => a + (c.lines_added ?? 0), 0);
          const removed = f.list.reduce((a, c) => a + (c.lines_removed ?? 0), 0);
          return (
            <tr key={f.path}>
              <td style={indent}>
                {first?.event_uuid ? (
                  <a href={`#ev-${first.event_uuid}`} className="title" title={f.path + " — jump to the first change"}>
                    {f.name}
                  </a>
                ) : (
                  <span title={f.path}>{f.name}</span>
                )}
              </td>
              <td className="num">
                {f.list.length}× <span className="muted">(+{added} −{removed})</span>
              </td>
              <td>
                <Link className="subagent-link small" to={`/file?path=${encodeURIComponent(f.path)}`}>
                  history →
                </Link>
              </td>
            </tr>
          );
        })}
    </>
  );
}

/** "Files changed" roll-up in the transcript header (ADR-022): the session's derived Edit/Write file
 * modifications, grouped per file and rendered as a compressed directory tree. Collapsed by default
 * (native <details>, like the subagent run groups); each file jumps to its first change's transcript
 * event and links to its provenance page. Rendered only when the session changed at least one file. */
function FilesChangedPanel({ changes, projectPath }: { changes: FileChangeRow[]; projectPath: string | null }) {
  const byFile = new Map<string, FileChangeRow[]>();
  for (const c of changes) (byFile.get(c.file_path) ?? byFile.set(c.file_path, []).get(c.file_path))!.push(c);
  const rel = (p: string) =>
    projectPath && p.startsWith(projectPath.replace(/\/$/, "") + "/") ? p.slice(projectPath.replace(/\/$/, "").length + 1) : p;
  const tree = buildFileTree([...byFile.entries()].map(([path, list]) => ({ display: rel(path), path, list })));
  return (
    <details className="wf-run files-changed">
      <summary>
        📄 {byFile.size} {byFile.size === 1 ? "file" : "files"} changed · {changes.length}{" "}
        {changes.length === 1 ? "edit" : "edits"}
      </summary>
      <table className="sessions">
        <tbody>
          <FileTreeRows node={tree} depth={0} />
        </tbody>
      </table>
    </details>
  );
}

function ToolChip({ t }: { t: ToolCall }) {
  const [open, setOpen] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const bodyId = useId();
  const label = t.skill_name
    ? `Skill · ${t.skill_name}`
    : t.tool_name === "Workflow" && t.workflow_name
      ? `Workflow · ${t.workflow_name}`
      : t.agent_type
        ? `${t.tool_name} → ${t.agent_type}`
        : t.tool_name;
  return (
    <div className={"tool " + (t.status === "error" ? "tool-err" : "")}>
      <button className="tool-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
        <span className="tool-name">🔧 {label}</span>
        {t.status && <span className="tool-status">{t.status}</span>}
        {t.total_duration_ms ? <span className="muted">{fmtDuration(t.total_duration_ms)}</span> : null}
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {t.spawned_session_id && (
        <Link className="subagent-link small" to={`/session/${t.spawned_session_id}`}>
          view subagent transcript →
        </Link>
      )}
      {t.workflow_run_id && (
        <Link className="subagent-link small" to={`/workflow/${t.workflow_run_id}`}>
          🔀 launched {t.workflow_agent_count ?? 0} agent{t.workflow_agent_count === 1 ? "" : "s"} · <code>{t.workflow_run_id}</code> →
        </Link>
      )}
      {t.skill_name && (
        <Link
          className="subagent-link small"
          to={`/skill/${encodeURIComponent(t.skill_name)}${t.skill_id ? `?v=${t.skill_id}` : ""}`}
        >
          📖 view skill{t.skill_id ? " version" : ""} →
        </Link>
      )}
      {open && (
        <div className="tool-body" id={bodyId}>
          {t.input_json && t.input_json !== "{}" && (
            <div className="code-block">
              <CopyButton text={prettyJson(t.input_json)} className="copy-corner" title="Copy tool input JSON" />
              <pre className="code">{prettyJson(t.input_json)}</pre>
            </div>
          )}
          {t.result_summary && <div className="result">{t.result_summary}</div>}
          {t.full_result && (
            <div className="full-result">
              <button
                type="button"
                className="ghost small show-full"
                aria-expanded={showFull}
                onClick={() => setShowFull((s) => !s)}
              >
                {showFull ? "Hide" : "Show"} full result ({(t.full_result.bytes / 1024).toFixed(1)} KB)
              </button>
              {showFull && (
                <div className="code-block">
                  <CopyButton text={t.full_result.text} className="copy-corner" title="Copy full tool result" />
                  <pre className="code">{t.full_result.text}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Pull the plan markdown out of an ExitPlanMode call's input. Real approvals carry the full plan in
 * `input.plan`; the plan-file workflow variant sends `{}` (plan lives in a file) → null, and we fall
 * back to the generic chip. */
function parsePlan(inputJson: string | null): string | null {
  if (!inputJson) return null;
  try {
    const plan = JSON.parse(inputJson).plan;
    return typeof plan === "string" && plan.trim() ? plan : null;
  } catch {
    return null;
  }
}

/** Render an approved plan as its own titled, collapsible card (markdown), instead of a raw JSON tool
 * chip or an opaque "Plan approved" line. */
function PlanBlock({ plan }: { plan: string }) {
  return (
    <div className="plan-card">
      <div className="plan-card-head">📋 Approved plan</div>
      <CollapsibleText text={plan} />
    </div>
  );
}

interface AUQOption {
  label: string;
  description?: string;
}
interface AUQQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AUQOption[];
}

function parseQuestions(inputJson: string | null): AUQQuestion[] {
  if (!inputJson) return [];
  try {
    const q = JSON.parse(inputJson).questions;
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}

/** Answers/notes for an AskUserQuestion, both keyed by question text. Present only for sessions ingested
 * after answer-capture landed; older rows have a prose summary that won't parse → empty (questions and
 * options still render, just without the selection marked). */
function parseAnswers(resultSummary: string | null): {
  answers: Record<string, string | string[]>;
  annotations: Record<string, { notes?: string }>;
} {
  if (!resultSummary) return { answers: {}, annotations: {} };
  try {
    const o = JSON.parse(resultSummary);
    if (o && typeof o === "object" && o.answers) return { answers: o.answers, annotations: o.annotations ?? {} };
  } catch {
    /* pre-capture prose summary — no structured answers */
  }
  return { answers: {}, annotations: {} };
}

/** Render an AskUserQuestion exchange as the questions it posed, each option shown, the user's
 * selection(s) checked, custom ("Other") answers surfaced, and any written notes — with the raw JSON
 * one click away for advanced users. Far more legible than the raw tool-input JSON block. */
function AskUserQuestionBlock({ t }: { t: ToolCall }) {
  const [raw, setRaw] = useState(false);
  const rawId = useId();
  const questions = parseQuestions(t.input_json);
  const { answers, annotations } = parseAnswers(t.result_summary);
  if (questions.length === 0) return <ToolChip t={t} />; // no question data → fall back to the chip
  return (
    <div className="qa-card">
      <div className="qa-card-head">🙋 Question{questions.length === 1 ? "" : "s"} for the user</div>
      {questions.map((q, qi) => {
        const ans = answers[q.question];
        const chosen = Array.isArray(ans) ? ans : ans != null ? [ans] : [];
        const chosenSet = new Set(chosen);
        const optionLabels = new Set(q.options.map((o) => o.label));
        const customs = chosen.filter((c) => !optionLabels.has(c));
        const note = annotations[q.question]?.notes;
        return (
          <div key={qi} className="qa-q">
            <div className="qa-q-head">
              {q.header && <span className="tag">{q.header}</span>}
              {q.multiSelect && <span className="muted small">multi-select</span>}
            </div>
            <div className="qa-question">{q.question}</div>
            <ul className="qa-options">
              {q.options.map((o, oi) => {
                const sel = chosenSet.has(o.label);
                return (
                  <li key={oi} className={"qa-opt" + (sel ? " is-selected" : "")}>
                    <span className="qa-mark" aria-hidden="true">{sel ? "☑" : "☐"}</span>
                    <span className="qa-opt-body">
                      <span className="qa-opt-label">{o.label}</span>
                      {o.description && <span className="qa-opt-desc muted">{o.description}</span>}
                    </span>
                  </li>
                );
              })}
              {customs.map((c, ci) => (
                <li key={"c" + ci} className="qa-opt is-selected">
                  <span className="qa-mark" aria-hidden="true">☑</span>
                  <span className="qa-opt-body">
                    <span className="qa-opt-label">{c}</span>
                    <span className="qa-opt-desc muted">custom answer</span>
                  </span>
                </li>
              ))}
            </ul>
            {note && <div className="qa-note">📝 {note}</div>}
          </div>
        );
      })}
      <div className="launch-actions">
        <button className="ghost small" aria-expanded={raw} aria-controls={rawId} onClick={() => setRaw((r) => !r)}>
          {raw ? "Hide raw JSON ▴" : "View raw JSON ▾"}
        </button>
        <CopyButton
          text={prettyJson(t.input_json ?? "{}") + (t.result_summary ? "\n\n" + prettyJson(t.result_summary) : "")}
          label="JSON"
          title="Copy raw question JSON"
        />
      </div>
      {raw && (
        <pre id={rawId} className="code">
          {prettyJson(t.input_json ?? "{}")}
          {t.result_summary ? "\n\n" + prettyJson(t.result_summary) : ""}
        </pre>
      )}
    </div>
  );
}

/** A Workflow launch, rendered minimally in the transcript: the run name/status, the launch ack, and
 * a link into the workflow detail page — where the full launch payload (task list, script, raw JSON)
 * is rendered. The transcript deliberately stays compact; the big fan-out belongs on the workflow
 * page, not inline. Like Plans/Q&A it's a significant action, so it always shows. */
function WorkflowLaunchBlock({ t }: { t: ToolCall }) {
  const label = t.workflow_name ? `Workflow · ${t.workflow_name}` : "Workflow";
  return (
    <div className="tool launch-tool">
      <div className="launch-tool-head">
        <span className="tool-name">🔀 {label}</span>
        {t.status && <span className="tool-status">{t.status}</span>}
      </div>
      {t.workflow_run_id && (
        <Link className="subagent-link small" to={`/workflow/${t.workflow_run_id}`}>
          🔀 launched {t.workflow_agent_count ?? 0} agent{t.workflow_agent_count === 1 ? "" : "s"} · <code>{t.workflow_run_id}</code> →
        </Link>
      )}
      {t.result_summary && <div className="result">{t.result_summary}</div>}
    </div>
  );
}

interface BashInput {
  command: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
  restart?: boolean;
}

/** Pull the shell command (+ optional description/flags) out of a Bash tool call's input so it can be
 * rendered like a terminal instead of a raw JSON blob. Only `command` is guaranteed; the rest are
 * optional/version-dependent (surfaced as badges, with the raw JSON as the source of truth). Returns
 * null when there's no usable command (malformed/empty input) → caller falls back to the generic chip. */
function parseBashInput(inputJson: string | null): BashInput | null {
  if (!inputJson) return null;
  try {
    const o = JSON.parse(inputJson);
    if (!o || typeof o !== "object") return null;
    const command = typeof o.command === "string" ? o.command : "";
    if (!command.trim()) return null;
    return {
      command,
      description: typeof o.description === "string" ? o.description : undefined,
      timeout: typeof o.timeout === "number" ? o.timeout : undefined,
      run_in_background: o.run_in_background === true,
      restart: o.restart === true,
    };
  } catch {
    return null;
  }
}

/** A physical line of a shell command, tagged with whether it *starts* a new logical command (gets a
 * `$` prompt) or *continues* the previous one (heredoc body, open quote/`$(…)`, backslash or trailing
 * `|`/`&&`/`||` continuation → no prompt). */
type ShellLine = { text: string; cont: boolean };

/** Parse a heredoc opener at `line[i]` (`<<` / `<<-`, optional spaces, optionally quoted delimiter),
 * push its delimiter onto `heredocs`, and return the index of its last consumed char. */
function scanHeredoc(line: string, i: number, heredocs: { delim: string; strip: boolean }[]): number {
  let j = i + 2; // past "<<"
  let strip = false;
  if (line[j] === "-") {
    strip = true;
    j++;
  }
  while (line[j] === " " || line[j] === "\t") j++;
  let q = "";
  if (line[j] === "'" || line[j] === '"') {
    q = line[j];
    j++;
  }
  let delim = "";
  if (q) {
    while (j < line.length && line[j] !== q) delim += line[j++];
    if (line[j] === q) j++;
  } else {
    while (j < line.length && /[A-Za-z0-9_]/.test(line[j])) delim += line[j++];
  }
  if (delim) heredocs.push({ delim, strip });
  return j - 1; // caller's for-loop does i++
}

/** Split a (possibly multi-command, multi-line) shell command into physical lines, marking which start
 * a new command vs. continue the previous one — so each real command gets a `$` prompt and heredoc
 * bodies / continuations don't. A pragmatic scanner honoring single/double quotes, `$(…)`/subshell
 * depth, heredocs (incl. mid-command, e.g. `"$(cat <<'EOF'…)"`), backslash and trailing-operator
 * continuations. Control-structure bodies outside a heredoc (a bare multi-line `for`/`if`) aren't
 * tracked, so each of their lines gets its own `$` — acceptable since those are rare as a raw command. */
function splitShellCommand(command: string): ShellLine[] {
  const lines = command.split("\n");
  const out: ShellLine[] = [];
  let mode: "NORMAL" | "SQUOTE" | "DQUOTE" = "NORMAL";
  let parenDepth = 0;
  const heredocs: { delim: string; strip: boolean }[] = [];
  let pendingCont = false;

  for (const line of lines) {
    if (heredocs.length > 0) {
      out.push({ text: line, cont: true }); // heredoc body — literal, never a new command
      const hd = heredocs[0];
      const probe = hd.strip ? line.replace(/^\t+/, "") : line;
      if (probe.trimEnd() === hd.delim) heredocs.shift();
      continue;
    }

    out.push({ text: line, cont: mode !== "NORMAL" || parenDepth > 0 || pendingCont });

    pendingCont = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (mode === "SQUOTE") {
        if (c === "'") mode = "NORMAL";
        continue;
      }
      if (mode === "DQUOTE") {
        if (c === "\\") i++;
        else if (c === '"') mode = "NORMAL";
        else if (c === "$" && line[i + 1] === "(") (parenDepth++, i++);
        else if (c === ")") parenDepth > 0 && parenDepth--;
        else if (c === "<" && line[i + 1] === "<" && line[i + 2] !== "<") i = scanHeredoc(line, i, heredocs);
        continue;
      }
      // NORMAL
      if (c === "\\") i++;
      else if (c === "'") mode = "SQUOTE";
      else if (c === '"') mode = "DQUOTE";
      else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) break; // trailing comment
      else if (c === "$" && line[i + 1] === "(") (parenDepth++, i++);
      else if (c === "(") parenDepth++;
      else if (c === ")") parenDepth > 0 && parenDepth--;
      else if (c === "<" && line[i + 1] === "<" && line[i + 2] !== "<") i = scanHeredoc(line, i, heredocs);
    }

    if (mode === "NORMAL" && parenDepth === 0 && heredocs.length === 0) {
      const t = line.replace(/\s+$/, "");
      const bs = t.match(/\\+$/);
      if (bs && bs[0].length % 2 === 1) pendingCont = true;
      else if (/(&&|\|\||\|)$/.test(t)) pendingCont = true;
    }
  }
  return out;
}

/** Render a Bash tool call as a shell console: the description as a `#` caption beside the title (or, if
 * absent, a one-line command preview when collapsed), and when open a terminal-style command block with
 * a `$` prompt per logical command (heredoc bodies / continuations get no prompt), flag badges, the
 * command output, and the raw input JSON one click away. Mirrors ToolChip's collapsible container +
 * result rendering so hide-tools/collapse behaviour is unchanged. */
function BashBlock({ t, bash }: { t: ToolCall; bash: BashInput }) {
  const [open, setOpen] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [raw, setRaw] = useState(false);
  const bodyId = useId();
  const rawId = useId();
  const preview = bash.command.split("\n")[0];
  const lines = splitShellCommand(bash.command);
  return (
    <div className={"tool " + (t.status === "error" ? "tool-err" : "")}>
      <button className="tool-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
        <span className="tool-name">🖥 Bash</span>
        {bash.description ? (
          <span className="bash-desc"># {bash.description}</span>
        ) : (
          !open && <span className="bash-preview">{preview}</span>
        )}
        {t.status && <span className="tool-status">{t.status}</span>}
        {t.total_duration_ms ? <span className="muted">{fmtDuration(t.total_duration_ms)}</span> : null}
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tool-body" id={bodyId}>
          <div className="shell code-block">
            <CopyButton text={bash.command} className="copy-corner" title="Copy command" />
            <pre className="shell-cmd">
              {lines.map((l, i) => (
                <span key={i}>
                  <span className={"shell-gutter" + (l.cont ? " cont" : "")} aria-hidden="true">
                    {l.cont ? "  " : "$ "}
                  </span>
                  {l.text}
                  {i < lines.length - 1 ? "\n" : ""}
                </span>
              ))}
            </pre>
          </div>
          {(bash.run_in_background || bash.restart || bash.timeout != null) && (
            <div className="bash-badges">
              {bash.run_in_background && <span className="bash-badge">background</span>}
              {bash.restart && <span className="bash-badge">restart</span>}
              {bash.timeout != null && <span className="bash-badge">timeout {Math.round(bash.timeout / 1000)}s</span>}
            </div>
          )}
          {t.result_summary && <pre className="shell-out">{t.result_summary}</pre>}
          {t.full_result && (
            <div className="full-result">
              <button
                type="button"
                className="ghost small show-full"
                aria-expanded={showFull}
                onClick={() => setShowFull((s) => !s)}
              >
                {showFull ? "Hide" : "Show"} full result ({(t.full_result.bytes / 1024).toFixed(1)} KB)
              </button>
              {showFull && (
                <div className="code-block">
                  <CopyButton text={t.full_result.text} className="copy-corner" title="Copy full tool result" />
                  <pre className="code">{t.full_result.text}</pre>
                </div>
              )}
            </div>
          )}
          <div className="launch-actions">
            <button className="ghost small" aria-expanded={raw} aria-controls={rawId} onClick={() => setRaw((r) => !r)}>
              {raw ? "Hide raw JSON ▴" : "View raw JSON ▾"}
            </button>
            <CopyButton text={prettyJson(t.input_json ?? "{}")} label="JSON" title="Copy raw tool input JSON" />
          </div>
          {raw && (
            <pre id={rawId} className="code">
              {prettyJson(t.input_json ?? "{}")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

type DiffLine = { type: "ctx" | "add" | "del"; text: string };

/** Line-level LCS diff between two strings — the basis for rendering an Edit as a +/- diff with
 * unchanged context lines kept. Guards against pathological cost on very large edits by falling back to
 * a delete-all + add-all rendering. */
function diffLines(oldStr: string, newStr: string): DiffLine[] {
  const a = oldStr === "" ? [] : oldStr.split("\n");
  const b = newStr === "" ? [] : newStr.split("\n");
  const n = a.length;
  const m = b.length;
  if (n * m > 250000)
    return [...a.map((t) => ({ type: "del" as const, text: t })), ...b.map((t) => ({ type: "add" as const, text: t }))];
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) (out.push({ type: "ctx", text: a[i] }), i++, j++);
    else if (dp[i + 1][j] >= dp[i][j + 1]) (out.push({ type: "del", text: a[i] }), i++);
    else (out.push({ type: "add", text: b[j] }), j++);
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

interface EditView {
  file_path: string;
  kind: "Edit" | "MultiEdit" | "Write";
  hunks: DiffLine[][];
  adds: number;
  dels: number;
}

/** Normalize an Edit / MultiEdit / Write tool input into diff hunks: Edit → one hunk (old→new),
 * MultiEdit → one hunk per edit, Write → one all-additions hunk (new file content). Returns null when
 * the input lacks a file path / usable payload, so the caller falls back to the generic chip. */
function parseEditInput(toolName: string, inputJson: string | null): EditView | null {
  if (!inputJson) return null;
  try {
    const o = JSON.parse(inputJson);
    if (!o || typeof o !== "object" || typeof o.file_path !== "string") return null;
    let hunks: DiffLine[][];
    if (toolName === "Write") {
      if (typeof o.content !== "string") return null;
      hunks = [o.content === "" ? [] : o.content.split("\n").map((text: string) => ({ type: "add" as const, text }))];
    } else if (toolName === "MultiEdit") {
      if (!Array.isArray(o.edits)) return null;
      hunks = o.edits
        .filter((e: unknown): e is { old_string: string; new_string: string } => {
          const r = e as Record<string, unknown>;
          return !!r && typeof r.old_string === "string" && typeof r.new_string === "string";
        })
        .map((e: { old_string: string; new_string: string }) => diffLines(e.old_string, e.new_string));
      if (hunks.length === 0) return null;
    } else {
      if (typeof o.old_string !== "string" || typeof o.new_string !== "string") return null;
      hunks = [diffLines(o.old_string, o.new_string)];
    }
    let adds = 0;
    let dels = 0;
    for (const h of hunks)
      for (const l of h) {
        if (l.type === "add") adds++;
        else if (l.type === "del") dels++;
      }
    return { file_path: o.file_path, kind: toolName as EditView["kind"], hunks, adds, dels };
  } catch {
    return null;
  }
}

/** Split a file path into a directory prefix and basename for the header (basename emphasized). */
function splitPath(p: string): { dir: string; base: string } {
  const i = p.lastIndexOf("/");
  return i >= 0 ? { dir: p.slice(0, i + 1), base: p.slice(i + 1) } : { dir: "", base: p };
}

const EDIT_ICON: Record<string, string> = { Edit: "✏️", MultiEdit: "✏️", Write: "📄" };
const DIFF_MAX_LINES = 400;

/** Render an Edit / MultiEdit / Write tool call as a colored +/- diff (unchanged lines shown as muted
 * context) instead of a raw JSON blob: the file basename + path and a `+adds −dels` stat in the header,
 * one diff block per edit (capped, with a spill note), the result, and the raw input JSON one click
 * away. Mirrors BashBlock's collapsible container so hide-tools/collapse behaviour is unchanged. */
function EditBlock({ t, edit }: { t: ToolCall; edit: EditView }) {
  const [open, setOpen] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [raw, setRaw] = useState(false);
  const bodyId = useId();
  const rawId = useId();
  const { dir, base } = splitPath(edit.file_path);
  return (
    <div className={"tool " + (t.status === "error" ? "tool-err" : "")}>
      <button className="tool-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
        <span className="tool-name">
          {EDIT_ICON[edit.kind] ?? "✏️"} {edit.kind}
        </span>
        <span className="edit-path">
          <span className="base">{base}</span>
          {dir && <span className="dir">{dir.replace(/\/$/, "")}</span>}
        </span>
        <span className="diff-stat">
          {edit.adds > 0 && <span className="add">+{edit.adds}</span>}
          {edit.dels > 0 && <span className="del">−{edit.dels}</span>}
        </span>
        {t.status && <span className="tool-status">{t.status}</span>}
        {t.total_duration_ms ? <span className="muted">{fmtDuration(t.total_duration_ms)}</span> : null}
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tool-body" id={bodyId}>
          {edit.hunks.map((hunk, hi) => (
            <div key={hi} className="diff">
              {edit.hunks.length > 1 && <div className="diff-hunk-sep">edit {hi + 1}</div>}
              {hunk.slice(0, DIFF_MAX_LINES).map((l, i) => (
                <div key={i} className={"diff-line " + l.type}>
                  <span className="diff-sign" aria-hidden="true">
                    {l.type === "add" ? "+" : l.type === "del" ? "−" : " "}
                  </span>
                  <span className="diff-text">{l.text === "" ? " " : l.text}</span>
                </div>
              ))}
              {hunk.length > DIFF_MAX_LINES && (
                <div className="diff-more">… {hunk.length - DIFF_MAX_LINES} more lines — View raw JSON for the rest</div>
              )}
            </div>
          ))}
          {t.result_summary && <pre className="shell-out">{t.result_summary}</pre>}
          {t.full_result && (
            <div className="full-result">
              <button
                type="button"
                className="ghost small show-full"
                aria-expanded={showFull}
                onClick={() => setShowFull((s) => !s)}
              >
                {showFull ? "Hide" : "Show"} full result ({(t.full_result.bytes / 1024).toFixed(1)} KB)
              </button>
              {showFull && (
                <div className="code-block">
                  <CopyButton text={t.full_result.text} className="copy-corner" title="Copy full tool result" />
                  <pre className="code">{t.full_result.text}</pre>
                </div>
              )}
            </div>
          )}
          <div className="launch-actions">
            <button className="ghost small" aria-expanded={raw} aria-controls={rawId} onClick={() => setRaw((r) => !r)}>
              {raw ? "Hide raw JSON ▴" : "View raw JSON ▾"}
            </button>
            <CopyButton text={prettyJson(t.input_json ?? "{}")} label="JSON" title="Copy raw tool input JSON" />
          </div>
          {raw && (
            <pre id={rawId} className="code">
              {prettyJson(t.input_json ?? "{}")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** One tool call, routed to its renderer: approved plans, AskUserQuestion, and Workflow launches get
 * rich cards (always shown); Bash gets a shell-console card and Edit/MultiEdit/Write a colored diff;
 * every other tool is a generic chip that the "hide tool messages" toggle can suppress. */
function ToolRender({ t, hideTools }: { t: ToolCall; hideTools: boolean }) {
  const findings = t.findings ?? [];
  // A flagged tool is always worth showing: findings override the "hide tool messages" toggle so a
  // risky command is never hidden behind it (the security signal is the whole point).
  const hide = hideTools && findings.length === 0;
  const inner = renderToolInner(t, hide);
  if (findings.length === 0) return inner;
  return (
    <>
      {inner}
      <ToolFindings findings={findings} />
    </>
  );
}

/** The tool card itself, routed to its renderer (no findings). Returns null when the current toggle
 * hides it. */
function renderToolInner(t: ToolCall, hide: boolean) {
  if (t.tool_name === "ExitPlanMode") {
    const plan = parsePlan(t.input_json);
    if (plan) return <PlanBlock plan={plan} />;
  }
  if (t.tool_name === "AskUserQuestion") return <AskUserQuestionBlock t={t} />;
  if (t.tool_name === "Workflow") return <WorkflowLaunchBlock t={t} />;
  if (t.tool_name === "Bash") {
    const bash = parseBashInput(t.input_json);
    if (bash) return hide ? null : <BashBlock t={t} bash={bash} />;
  }
  if (t.tool_name === "Edit" || t.tool_name === "MultiEdit" || t.tool_name === "Write") {
    const edit = parseEditInput(t.tool_name, t.input_json);
    if (edit) return hide ? null : <EditBlock t={t} edit={edit} />;
  }
  return hide ? null : <ToolChip t={t} />;
}

/** Whether a tool call renders anything under the current toggle — Plans/Q&A/Workflow launches always
 * do; generic chips only when tools aren't hidden. Used so an event with nothing left to show
 * collapses away entirely. */
function toolVisible(t: ToolCall, hideTools: boolean): boolean {
  if (t.findings && t.findings.length) return true; // flagged tools always show (see ToolRender)
  if (t.tool_name === "AskUserQuestion") return true;
  if (t.tool_name === "Workflow") return true;
  if (t.tool_name === "ExitPlanMode" && parsePlan(t.input_json)) return true;
  return !hideTools;
}

/** Claude Code wraps slash-command invocations and their local output in markup tags inside a
 * user message (e.g. `<command-name>/plugin</command-name>`, `<local-command-stdout>…`). Rendered
 * verbatim that looks like noise, so we detect and render it as a distinct command element. */
type ParsedCommand =
  | { kind: "invocation"; name: string; args: string }
  | { kind: "output"; stdout: string }
  | { kind: "caveat" };

function parseCommand(text: string): ParsedCommand | null {
  const name = text.match(/<command-name>([^<]*)<\/command-name>/)?.[1]?.trim();
  if (name) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim() ?? "";
    return { kind: "invocation", name: name.startsWith("/") ? name : `/${name}`, args };
  }
  const out = text.match(/<(?:local-command-stdout|command-output|local-command-stderr)>([\s\S]*?)<\/(?:local-command-stdout|command-output|local-command-stderr)>/)?.[1];
  if (out != null) return { kind: "output", stdout: out.trim() };
  if (/<local-command-caveat>/.test(text)) return { kind: "caveat" };
  return null;
}

/** Render a slash command as an outlined, monospace chip (the invocation) with its local output as a
 * muted result block — instead of the raw `<command-*>` markup. */
function CommandBlock({ cmd }: { cmd: ParsedCommand }) {
  if (cmd.kind === "invocation")
    return (
      <div className="cmd">
        <span className="cmd-chip" title="Slash command">⌘ {cmd.name}</span>
        {cmd.args && <code className="cmd-args">{cmd.args}</code>}
      </div>
    );
  if (cmd.kind === "output")
    return (
      <div className="cmd-out">
        {cmd.stdout && cmd.stdout !== "(no content)" ? cmd.stdout : <span className="muted">no output</span>}
      </div>
    );
  return <div className="cmd-note muted small">⌘ local command context</div>;
}

/** Claude Code posts a `<task-notification>` user message when an async task (Workflow run, or a
 * backgrounded Agent) finishes. Rendered verbatim it's a wall of XML; we parse the inner tags so it
 * can show as a compact status card that links back to the workflow it reports on. */
interface ParsedTaskNotification {
  taskId: string | null;
  toolUseId: string | null;
  status: string | null;
  summary: string | null;
}

function parseTaskNotification(text: string): ParsedTaskNotification | null {
  if (!/<task-notification>/.test(text)) return null;
  const pick = (tag: string) => text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? null;
  return {
    taskId: pick("task-id"),
    toolUseId: pick("tool-use-id"),
    status: pick("status"),
    summary: pick("summary"),
  };
}

/** Render a parsed task-notification as a status card: a status badge, the summary, and the task id —
 * plus a "view workflow →" link when the originating tool-use-id resolves to a Workflow run. */
function TaskNotificationBlock({ n }: { n: ParsedTaskNotification }) {
  const wfMap = useContext(WorkflowMapContext);
  const runId = n.toolUseId ? wfMap.get(n.toolUseId) : undefined;
  const status = (n.status ?? "").toLowerCase();
  return (
    <div className="task-notif">
      <div className="task-notif-head">
        <span className="task-notif-icon" aria-hidden="true">🔔</span>
        {n.status && <span className={"tag task-status task-status-" + status}>{n.status}</span>}
        {n.taskId && <code className="task-notif-id">task {n.taskId}</code>}
        {runId && (
          <Link className="subagent-link small" to={`/workflow/${runId}`}>
            view workflow →
          </Link>
        )}
      </div>
      {n.summary && <div className="task-notif-summary">{n.summary}</div>}
    </div>
  );
}

/** A message body rendered per the active format: GitHub-flavored markdown (default) or the raw
 * text verbatim. The "text" class is kept on both so the clamp/fade styling targets either. */
function MessageBody({ text, id }: { text: string; id?: string }) {
  const format = useContext(FormatContext);
  if (format === "raw") {
    return <div className="text" id={id}>{text}</div>;
  }
  return (
    <div className="text md" id={id}>
      <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {text}
      </Markdown>
    </div>
  );
}

/** Open links in a new tab and keep them safe; react-markdown sanitizes by default (no raw HTML).
 * `node` is react-markdown's internal AST handle — drop it so it isn't emitted as a DOM attribute. */
const MD_COMPONENTS = {
  a: ({ node, ...props }: any) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

/** Long message bodies are clamped to a preview height with a show-more toggle so a single big
 * message doesn't force endless scrolling; short messages render in full untouched. */
function CollapsibleText({ text }: { text: string }) {
  const long = text.length > 1400 || text.split("\n").length > 18;
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  if (!long) return <MessageBody text={text} />;
  return (
    <div className={"text-wrap" + (expanded ? "" : " is-clamped")}>
      <MessageBody text={text} id={bodyId} />
      <button
        className="ghost small show-more"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? "Show less ▴" : "Show more ▾"}
      </button>
    </div>
  );
}

interface TurnGroup {
  turnId: string | null;
  turn: any | null;
  events: EventNode[];
}

/** Group consecutive renderable events into their turns, preserving transcript order. Events with no
 * turn (e.g. leading meta lines) fall into header-less groups so they still render. */
function groupByTurn(events: EventNode[], turns: any[]): TurnGroup[] {
  const byId = new Map(turns.map((t) => [t.id, t]));
  const groups: TurnGroup[] = [];
  for (const e of events) {
    const turnId = e.turn_id ?? null;
    const last = groups[groups.length - 1];
    if (last && last.turnId === turnId) last.events.push(e);
    else groups.push({ turnId, turn: turnId ? byId.get(turnId) ?? null : null, events: [e] });
  }
  return groups;
}

/** A turn's prompt preview, with slash-command markup collapsed to a readable label so the turn
 * header doesn't show raw `<command-name>…` tags. */
function previewLabel(text: string): string {
  const cmd = parseCommand(text);
  if (cmd?.kind === "invocation") return `⌘ ${cmd.name}${cmd.args ? " " + cmd.args : ""}`;
  if (cmd?.kind === "output") return "⌘ command output";
  if (cmd?.kind === "caveat") return "⌘ local command";
  const notif = parseTaskNotification(text);
  if (notif) return `🔔 task ${notif.status ?? "notification"}`;
  return text;
}

/** A collapsible turn: the header stays visible (turn no., prompt preview, message count, duration)
 * so a long transcript can be scanned and navigated; the messages render only while expanded. */
function TurnSection({ turn, events, open, onToggle }: { turn: any; events: EventNode[]; open: boolean; onToggle: () => void }) {
  const regionId = useId();
  return (
    <section className={"turn" + (open ? " is-open" : "")}>
      <button className="turn-head" aria-expanded={open} aria-controls={regionId} onClick={onToggle}>
        <span className="chev turn-chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="turn-no">turn {turn.seq + 1}</span>
        {turn.prompt_preview ? <span className="turn-preview">{previewLabel(turn.prompt_preview)}</span> : null}
        <span className="turn-stats muted">
          {events.length} msg{events.length === 1 ? "" : "s"}
          {turn.duration_ms ? " · " + fmtDuration(turn.duration_ms) : ""}
        </span>
      </button>
      <div id={regionId} className="turn-body" role="region" aria-label={`turn ${turn.seq + 1} messages`}>
        {open && events.map((e) => <EventBlock key={e.uuid} e={e} />)}
      </div>
    </section>
  );
}

function EventBlock({ e }: { e: EventNode }) {
  const [showThinking, setShowThinking] = useState(false);
  const thinkId = useId();
  const hideTools = useContext(HideToolsContext);
  const flashUuid = useContext(FlashContext);
  const who = e.role || e.type;
  const icon = who === "user" ? "👤" : who === "assistant" ? "🤖" : "⚙️";
  const visibleTools = e.toolCalls.filter((t) => toolVisible(t, hideTools));
  const hasBody = e.text || e.thinking || visibleTools.length;
  if (!hasBody) return null;
  const cmd = e.text ? parseCommand(e.text) : null;
  const notif = e.text && !cmd ? parseTaskNotification(e.text) : null;
  // What the message-level copy button grabs: the visible body, else the thinking text.
  const copyText = e.text || e.thinking || "";
  return (
    // id lets a security finding (or any deep link) anchor to the exact message via #ev-<event_uuid>.
    <div id={"ev-" + e.uuid} className={"event ev-" + who + (flashUuid === e.uuid ? " ev-flagged" : "")}>
      <div className="ev-meta">
        <span className="ev-who">
          {icon} {who}
        </span>
        {e.model && <span className="tag">{shortModel(e.model)}</span>}
        {e.is_sidechain ? <span className="tag subagent">subagent</span> : null}
        <span className="muted ev-time">{fmtDate(e.timestamp)}</span>
        {copyText && <CopyButton text={copyText} className="ev-copy copy-hover" title="Copy message" />}
      </div>
      {e.thinking && (
        <div className="thinking">
          <button className="thinking-toggle" aria-expanded={showThinking} aria-controls={thinkId} onClick={() => setShowThinking((s) => !s)}>
            🧠 thinking {showThinking ? "▾" : "▸"}
          </button>
          {showThinking && (
            <div className="code-block">
              <CopyButton text={e.thinking} className="copy-corner" title="Copy thinking" />
              <pre id={thinkId} className="thinking-body">{e.thinking}</pre>
            </div>
          )}
        </div>
      )}
      {e.text && (cmd ? <CommandBlock cmd={cmd} /> : notif ? <TaskNotificationBlock n={notif} /> : <CollapsibleText text={e.text} />)}
      {visibleTools.map((t, i) => (
        <ToolRender key={i} t={t} hideTools={hideTools} />
      ))}
    </div>
  );
}

/** One spawned-subagent row. Prefers the meta sidecar's human description as the title, and surfaces
 * the authoritative agent type + nesting depth (from session_meta) that the transcript doesn't carry. */
function SubagentItem({ c }: { c: SessionChild }) {
  const title = c.agent_description || c.title || c.id.slice(0, 12);
  return (
    <li>
      <Link to={`/session/${c.id}`}>{title}</Link>
      {c.agent_type && <span className="tag subagent meta-type">{c.agent_type}</span>}
      {c.spawn_depth != null && c.spawn_depth > 1 && (
        <span className="tag meta-depth" title={`nested ${c.spawn_depth} levels deep`}>↳{c.spawn_depth}</span>
      )}
      <span className="muted">
        {" "}· {(c.models ?? "").split(",").filter(Boolean).map(shortModel).join(", ")} ·{" "}
        {fmtTokens(c.tokens)} tok · {fmtCost(c.cost)}
      </span>
    </li>
  );
}

/** Spawned subagents grouped by what launched them: one collapsible group per Workflow run (named,
 * counted, linked to the launching turn) and one for Task/Agent spawns — instead of one flat,
 * unattributed list. A run can fan out to dozens of agents, so groups are collapsed by default. */
function SubagentPanel({ d }: { d: SessionDetail }) {
  const runs = d.workflow_runs ?? [];
  const direct = d.children.filter((c) => !c.workflow_run_id);
  const grouped = runs.length > 0;
  return (
    <div className="subagents">
      <h2>Spawned subagents ({d.children.length})</h2>
      {runs.map((run) => {
        const kids = d.children.filter((c) => c.workflow_run_id === run.run_id);
        return (
          <details key={run.run_id} className="wf-run">
            <summary>
              <Link className="wf-run-name" to={`/workflow/${run.run_id}`} onClick={(e) => e.stopPropagation()}>
                🔀 {run.name || "workflow"} →
              </Link>
              {run.status && (
                <span className={"tag task-status task-status-" + run.status.toLowerCase()}>{run.status}</span>
              )}
              <span className="muted small">
                {kids.length} agent{kids.length === 1 ? "" : "s"}
                {run.turn_seq != null ? ` · turn ${run.turn_seq + 1}` : ""} · <code>{run.run_id}</code>
              </span>
            </summary>
            <ul>{kids.map((c) => <SubagentItem key={c.id} c={c} />)}</ul>
          </details>
        );
      })}
      {direct.length > 0 &&
        (grouped ? (
          <details className="wf-run" open>
            <summary>
              <span className="wf-run-name">Task / Agent</span>
              <span className="muted small">{direct.length} subagent{direct.length === 1 ? "" : "s"}</span>
            </summary>
            <ul>{direct.map((c) => <SubagentItem key={c.id} c={c} />)}</ul>
          </details>
        ) : (
          <ul>{direct.map((c) => <SubagentItem key={c.id} c={c} />)}</ul>
        ))}
    </div>
  );
}

export default function SessionView() {
  const { id } = useParams();
  const { hash } = useLocation();
  const [d, setD] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Turn ids that are collapsed. Empty = all expanded (preserves the prior always-open behavior).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // How message bodies render. Defaults to markdown; persisted so the choice sticks across sessions.
  const [format, setFormat] = useState<MsgFormat>(loadFormat);
  // Hide mechanical tool chips to read only the human-facing conversation. Persisted like format.
  const [hideTools, setHideTools] = useState<boolean>(loadHideTools);

  const chooseFormat = (f: MsgFormat) => {
    setFormat(f);
    try {
      localStorage.setItem(FORMAT_KEY, f);
    } catch {
      /* ignore unavailable storage */
    }
  };

  const toggleHideTools = () =>
    setHideTools((h) => {
      const next = !h;
      try {
        localStorage.setItem(HIDE_TOOLS_KEY, next ? "1" : "0");
      } catch {
        /* ignore unavailable storage */
      }
      return next;
    });

  useEffect(() => {
    setD(null);
    setError(null);
    setCollapsed(new Set());
    api<SessionDetail>("/sessions/" + id)
      .then(setD)
      .catch((e) => setError(String(e)));
  }, [id]);

  // Deep link `#ev-<event_uuid>` (e.g. from a security finding row) → scroll the flagged message into
  // view and flash it. Runs once per hash, after the transcript renders; if the target message sits in
  // a collapsed turn, expand that turn first and let the re-render bring the element into the DOM. The
  // flash is React-owned (via FlashContext) so it survives the re-render the expansion triggers.
  const [flashUuid, setFlashUuid] = useState<string | null>(null);
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!d) return;
    const m = /^#ev-(.+)$/.exec(hash);
    if (!m) {
      scrolledFor.current = null;
      return;
    }
    if (scrolledFor.current === hash) return;
    const uuid = m[1];
    const ev = d.events.find((e) => e.uuid === uuid);
    if (ev?.turn_id && collapsed.has(ev.turn_id)) {
      const turnId = ev.turn_id;
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(turnId);
        return next;
      });
      return; // re-render with the turn open, then this effect re-runs and scrolls
    }
    const el = document.getElementById("ev-" + uuid);
    if (!el) return;
    scrolledFor.current = hash;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlashUuid(uuid);
    const t = window.setTimeout(() => setFlashUuid(null), 3000);
    return () => window.clearTimeout(t);
  }, [d, hash, collapsed]);

  // tool-use-id → workflow run id, so a `<task-notification>` can link to its workflow detail page.
  const wfMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of d?.events ?? [])
      for (const t of e.toolCalls)
        if (t.tool_name === "Workflow" && t.id && t.workflow_run_id) m.set(t.id, t.workflow_run_id);
    return m;
  }, [d]);

  if (error) return <div className="error" role="alert">{error}</div>;
  if (!d) return <div className="muted pad" role="status" aria-live="polite">Loading…</div>;
  const s = d.session;

  // Events that actually render something (mirrors EventBlock's body check). A session with none
  // (e.g. a zero-turn session whose only line was a meta/command with no text) gets an empty-state
  // instead of a blank transcript area.
  const renderable = d.events.filter((e) => e.text || e.thinking || e.toolCalls.length);
  const groups = groupByTurn(renderable, d.turns);
  const collapsibleIds = groups.filter((g) => g.turn).map((g) => g.turnId as string);
  const anyOpen = collapsibleIds.some((tid) => !collapsed.has(tid));

  const toggleTurn = (tid: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(tid)) next.delete(tid);
      else next.add(tid);
      return next;
    });

  return (
    <div className="detail">
      <div className="detail-head">
        <Link to="/" className="back">
          ← all sessions
        </Link>
        <h1>{s.title || s.id.slice(0, 12)}</h1>
        <div className="detail-meta">
          <span><b>{s.source_id}</b></span>
          <span className="path">{s.project_path}</span>
          {s.is_sidechain ? <span className="tag subagent">subagent</span> : null}
          {d.parent && (
            <span className="spawned-by">
              ↖ spawned by{" "}
              <Link to={`/session/${d.parent.id}`}>{d.parent.title || d.parent.id.slice(0, 12)}</Link>
              {d.parent.turn_seq != null ? ` · turn ${d.parent.turn_seq + 1}` : ""}
            </span>
          )}
          <span>{d.turns.length} turns</span>
          <span>{s.event_count} events</span>
          <span title={tokenSplitTitle(s.token_split)}>{fmtTokens(s.tokens)} tok</span>
          <span title="Estimated at API list prices (cache-aware)">{fmtCost(s.cost)}</span>
          {s.tool_call_count > 0 && (
            <span
              className={s.tool_failure_count > 0 ? "tool-err-stat" : "muted"}
              title={
                "Tool calls that returned is_error, of " +
                s.tool_call_count +
                ". Failures = the agent's tool errored; declined/blocked = you rejected it or a guardrail blocked it " +
                "(heuristic split from the result text — not an API-reported distinction)."
              }
            >
              {s.tool_failure_count} failed
              {s.tool_rejection_count > 0 ? ` · ${s.tool_rejection_count} declined/blocked` : ""}
              {` of ${s.tool_call_count} tool calls`}
            </span>
          )}
          <span>{fmtDuration(s.duration_ms)}</span>
          <span className="muted">{fmtDate(s.started_at)}</span>
          <ExportMenu id={s.id} />
        </div>
        {d.classification && <ClassificationBadge c={d.classification} />}
        {d.findings && d.findings.length > 0 && <SecurityBanner findings={d.findings} sessionId={s.id} />}
        {d.file_changes && d.file_changes.length > 0 && (
          <FilesChangedPanel changes={d.file_changes} projectPath={s.project_path ?? null} />
        )}
      </div>

      {d.children && d.children.length > 0 && <SubagentPanel d={d} />}

      <div className="transcript-tools">
        {collapsibleIds.length > 1 && (
          <>
            <span className="muted small">{collapsibleIds.length} turns</span>
            <button
              className="ghost small"
              onClick={() => setCollapsed(anyOpen ? new Set(collapsibleIds) : new Set())}
            >
              {anyOpen ? "Collapse all" : "Expand all"}
            </button>
          </>
        )}
        <button
          className={"ghost small" + (hideTools ? " is-active" : "")}
          aria-pressed={hideTools}
          onClick={toggleHideTools}
          title="Hide Bash/Edit/Skill and other tool calls — show only assistant answers, plans and questions"
        >
          {hideTools ? "☑ " : "☐ "}Hide tool messages
        </button>
        <div className="format-toggle" role="group" aria-label="Message format">
          <button
            className={"ghost small" + (format === "markdown" ? " is-active" : "")}
            aria-pressed={format === "markdown"}
            onClick={() => chooseFormat("markdown")}
          >
            Markdown
          </button>
          <button
            className={"ghost small" + (format === "raw" ? " is-active" : "")}
            aria-pressed={format === "raw"}
            onClick={() => chooseFormat("raw")}
          >
            Raw
          </button>
        </div>
      </div>

      <WorkflowMapContext.Provider value={wfMap}>
      <FormatContext.Provider value={format}>
      <HideToolsContext.Provider value={hideTools}>
      <FlashContext.Provider value={flashUuid}>
      <div className="transcript">
        {renderable.length === 0 && (
          <div className="muted pad" role="status">
            This session has no rendered messages.
          </div>
        )}
        {groups.map((g, i) =>
          g.turn ? (
            <TurnSection
              key={g.turnId}
              turn={g.turn}
              events={g.events}
              open={!collapsed.has(g.turnId as string)}
              onToggle={() => toggleTurn(g.turnId as string)}
            />
          ) : (
            <div key={"unturned-" + i} className="unturned">
              {g.events.map((e) => (
                <EventBlock key={e.uuid} e={e} />
              ))}
            </div>
          ),
        )}
      </div>
      </FlashContext.Provider>
      </HideToolsContext.Provider>
      </FormatContext.Provider>
      </WorkflowMapContext.Provider>
    </div>
  );
}
