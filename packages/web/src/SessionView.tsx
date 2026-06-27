import { useEffect, useId, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Classification, type EventNode, type SessionDetail, type ToolCall } from "./api";
import { fmtCost, fmtDate, fmtDuration, fmtTokens, shortModel, tokenSplitTitle } from "./format";

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
        signals {open ? "▾" : "▸"}
      </button>
      {open && <pre id={panelId} className="code signals">{JSON.stringify(c.signals, null, 2)}</pre>}
    </div>
  );
}

function ToolChip({ t }: { t: ToolCall }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const label = t.skill_name ? `Skill · ${t.skill_name}` : t.agent_type ? `${t.tool_name} → ${t.agent_type}` : t.tool_name;
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

/** Long message bodies are clamped to a preview height with a show-more toggle so a single big
 * message doesn't force endless scrolling; short messages render in full untouched. */
function CollapsibleText({ text }: { text: string }) {
  const long = text.length > 1400 || text.split("\n").length > 18;
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  if (!long) return <div className="text">{text}</div>;
  return (
    <div className={"text-wrap" + (expanded ? "" : " is-clamped")}>
      <div className="text" id={bodyId}>
        {text}
      </div>
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

/** A collapsible turn: the header stays visible (turn no., prompt preview, message count, duration)
 * so a long transcript can be scanned and navigated; the messages render only while expanded. */
function TurnSection({ turn, events, open, onToggle }: { turn: any; events: EventNode[]; open: boolean; onToggle: () => void }) {
  const regionId = useId();
  return (
    <section className={"turn" + (open ? " is-open" : "")}>
      <button className="turn-head" aria-expanded={open} aria-controls={regionId} onClick={onToggle}>
        <span className="chev turn-chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="turn-no">turn {turn.seq + 1}</span>
        {turn.prompt_preview ? <span className="turn-preview">{turn.prompt_preview}</span> : null}
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
      {e.text && <CollapsibleText text={e.text} />}
      {e.toolCalls.map((t, i) => (
        <ToolChip key={i} t={t} />
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
          <span title="API list-price equivalent (cache-aware) — what a subscription saves you, not money spent">{fmtCost(s.cost)}</span>
          <span>{fmtDuration(s.duration_ms)}</span>
          <span className="muted">{fmtDate(s.started_at)}</span>
          <a className="export" href={`/api/sessions/${s.id}/export.md`}>
            ⬇ Export Markdown
          </a>
        </div>
        {d.classification && <ClassificationBadge c={d.classification} />}
      </div>

      {d.children && d.children.length > 0 && (
        <div className="subagents">
          <h2>Spawned subagents ({d.children.length})</h2>
          <ul>
            {d.children.map((c) => (
              <li key={c.id}>
                <Link to={`/session/${c.id}`}>{c.title || c.id.slice(0, 12)}</Link>
                <span className="muted">
                  {" "}· {(c.models ?? "").split(",").filter(Boolean).map(shortModel).join(", ")} ·{" "}
                  {fmtTokens(c.tokens)} tok · {fmtCost(c.cost)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {collapsibleIds.length > 1 && (
        <div className="transcript-tools">
          <span className="muted small">{collapsibleIds.length} turns</span>
          <button
            className="ghost small"
            onClick={() => setCollapsed(anyOpen ? new Set(collapsibleIds) : new Set())}
          >
            {anyOpen ? "Collapse all" : "Expand all"}
          </button>
        </div>
      )}

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
    </div>
  );
}
