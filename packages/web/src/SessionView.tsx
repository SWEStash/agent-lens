import { createContext, useContext, useEffect, useId, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, exportUrl, type Classification, type ClassificationSignals, type EventNode, type SessionChild, type SessionDetail, type ToolCall } from "./api";
import { fmtCost, fmtDate, fmtDuration, fmtTokens, shortModel, tokenSplitTitle } from "./format";
import { prettyJson } from "./jsonish";
import CopyButton from "./CopyButton";

/** How message bodies render: "markdown" (formatted, the default) or "raw" (verbatim text).
 * Provided once per SessionView and consumed deep in the tree by message bodies. */
export type MsgFormat = "markdown" | "raw";
const FormatContext = createContext<MsgFormat>("markdown");

/** Maps a Workflow tool_use id → its run id (wf_…), built once per SessionView from the transcript's
 * tool calls. Lets a `<task-notification>` (which carries the originating tool-use-id) link straight
 * to the workflow detail page. Tasks with no matching Workflow tool_call (e.g. a plain Agent spawn)
 * just won't resolve a link. */
const WorkflowMapContext = createContext<Map<string, string>>(new Map());

/** When true, mechanical tool-call chips (Bash, Edit, Skill, Read, …) are hidden so the transcript
 * reads as just the human-facing conversation. Plans and AskUserQuestion Q&A are kept regardless —
 * they're part of that conversation, not tool noise. */
const HideToolsContext = createContext<boolean>(false);

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

function ToolChip({ t }: { t: ToolCall }) {
  const [open, setOpen] = useState(false);
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

/** One tool call, routed to its renderer: approved plans, AskUserQuestion, and Workflow launches get
 * rich cards (always shown); every other tool is a generic chip that the "hide tool messages" toggle
 * can suppress. */
function ToolRender({ t, hideTools }: { t: ToolCall; hideTools: boolean }) {
  if (t.tool_name === "ExitPlanMode") {
    const plan = parsePlan(t.input_json);
    if (plan) return <PlanBlock plan={plan} />;
  }
  if (t.tool_name === "AskUserQuestion") return <AskUserQuestionBlock t={t} />;
  if (t.tool_name === "Workflow") return <WorkflowLaunchBlock t={t} />;
  return hideTools ? null : <ToolChip t={t} />;
}

/** Whether a tool call renders anything under the current toggle — Plans/Q&A/Workflow launches always
 * do; generic chips only when tools aren't hidden. Used so an event with nothing left to show
 * collapses away entirely. */
function toolVisible(t: ToolCall, hideTools: boolean): boolean {
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
    <div className={"event ev-" + who}>
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

/** One spawned-subagent row. */
function SubagentItem({ c }: { c: SessionChild }) {
  return (
    <li>
      <Link to={`/session/${c.id}`}>{c.title || c.id.slice(0, 12)}</Link>
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
          <span>{fmtDuration(s.duration_ms)}</span>
          <span className="muted">{fmtDate(s.started_at)}</span>
          <a className="export" href={exportUrl(s.id)}>
            ⬇ Export Markdown
          </a>
        </div>
        {d.classification && <ClassificationBadge c={d.classification} />}
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
      </HideToolsContext.Provider>
      </FormatContext.Provider>
      </WorkflowMapContext.Provider>
    </div>
  );
}
