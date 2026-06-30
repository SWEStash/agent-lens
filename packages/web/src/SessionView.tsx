import { createContext, useContext, useEffect, useId, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, exportUrl, type Classification, type ClassificationSignals, type EventNode, type SessionChild, type SessionDetail, type ToolCall } from "./api";
import { fmtCost, fmtDate, fmtDuration, fmtTokens, shortModel, tokenSplitTitle } from "./format";

/** How message bodies render: "markdown" (formatted, the default) or "raw" (verbatim text).
 * Provided once per SessionView and consumed deep in the tree by message bodies. */
export type MsgFormat = "markdown" | "raw";
const FormatContext = createContext<MsgFormat>("markdown");

const FORMAT_KEY = "agentlens.msgFormat";
function loadFormat(): MsgFormat {
  try {
    return localStorage.getItem(FORMAT_KEY) === "raw" ? "raw" : "markdown";
  } catch {
    return "markdown";
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
        <div className="subagent-link small muted">
          🔀 launched {t.workflow_agent_count ?? 0} agent{t.workflow_agent_count === 1 ? "" : "s"} · <code>{t.workflow_run_id}</code>
        </div>
      )}
      {open && (
        <div className="tool-body" id={bodyId}>
          {t.input_json && t.input_json !== "{}" && (
            <pre className="code">{prettyJson(t.input_json)}</pre>
          )}
          {t.result_summary && <div className="result">{t.result_summary}</div>}
        </div>
      )}
    </div>
  );
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

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2).slice(0, 4000);
  } catch {
    return s.slice(0, 4000);
  }
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
  const who = e.role || e.type;
  const icon = who === "user" ? "👤" : who === "assistant" ? "🤖" : "⚙️";
  const hasBody = e.text || e.thinking || e.toolCalls.length;
  if (!hasBody) return null;
  const cmd = e.text ? parseCommand(e.text) : null;
  return (
    <div className={"event ev-" + who}>
      <div className="ev-meta">
        <span className="ev-who">
          {icon} {who}
        </span>
        {e.model && <span className="tag">{shortModel(e.model)}</span>}
        {e.is_sidechain ? <span className="tag subagent">subagent</span> : null}
        <span className="muted ev-time">{fmtDate(e.timestamp)}</span>
      </div>
      {e.thinking && (
        <div className="thinking">
          <button className="thinking-toggle" aria-expanded={showThinking} aria-controls={thinkId} onClick={() => setShowThinking((s) => !s)}>
            🧠 thinking {showThinking ? "▾" : "▸"}
          </button>
          {showThinking && <pre id={thinkId} className="thinking-body">{e.thinking}</pre>}
        </div>
      )}
      {e.text && (cmd ? <CommandBlock cmd={cmd} /> : <CollapsibleText text={e.text} />)}
      {e.toolCalls.map((t, i) => (
        <ToolChip key={i} t={t} />
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
              <span className="wf-run-name">🔀 {run.name || "workflow"}</span>
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

  const chooseFormat = (f: MsgFormat) => {
    setFormat(f);
    try {
      localStorage.setItem(FORMAT_KEY, f);
    } catch {
      /* ignore unavailable storage */
    }
  };

  useEffect(() => {
    setD(null);
    setError(null);
    setCollapsed(new Set());
    api<SessionDetail>("/sessions/" + id)
      .then(setD)
      .catch((e) => setError(String(e)));
  }, [id]);

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

      <FormatContext.Provider value={format}>
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
      </FormatContext.Provider>
    </div>
  );
}
