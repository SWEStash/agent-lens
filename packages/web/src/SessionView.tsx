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
import { splitShellCommand } from "./transcript/shell";
import { buildFileTree, type FileTreeNode } from "./transcript/tree";
import { groupByTurn } from "./transcript/group";
import {
  parseAnswers,
  parseBashInput,
  parseCommand,
  parseEditInput,
  parsePlan,
  parseQuestions,
  parseTaskNotification,
  previewLabel,
  splitPath,
  type BashInput,
  type EditView,
  type ParsedCommand,
  type ParsedTaskNotification,
} from "./transcript/parse";

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
