import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Classification, type EventNode, type SessionDetail, type ToolCall } from "./api";
import { fmtCost, fmtDate, fmtDuration, fmtTokens, shortModel } from "./format";

function ClassificationBadge({ c }: { c: Classification }) {
  const [open, setOpen] = useState(false);
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
      <button className="ghost small" onClick={() => setOpen((o) => !o)}>
        signals {open ? "▾" : "▸"}
      </button>
      {open && <pre className="code signals">{JSON.stringify(c.signals, null, 2)}</pre>}
    </div>
  );
}

function ToolChip({ t }: { t: ToolCall }) {
  const [open, setOpen] = useState(false);
  const label = t.skill_name ? `Skill · ${t.skill_name}` : t.agent_type ? `${t.tool_name} → ${t.agent_type}` : t.tool_name;
  return (
    <div className={"tool " + (t.status === "error" ? "tool-err" : "")}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)}>
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
        <div className="tool-body">
          {t.input_json && t.input_json !== "{}" && (
            <pre className="code">{prettyJson(t.input_json)}</pre>
          )}
          {t.result_summary && <div className="result">{t.result_summary}</div>}
        </div>
      )}
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

function EventBlock({ e }: { e: EventNode }) {
  const [showThinking, setShowThinking] = useState(false);
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
          <button className="thinking-toggle" onClick={() => setShowThinking((s) => !s)}>
            🧠 thinking {showThinking ? "▾" : "▸"}
          </button>
          {showThinking && <pre className="thinking-body">{e.thinking}</pre>}
        </div>
      )}
      {e.text && <div className="text">{e.text}</div>}
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

  useEffect(() => {
    setD(null);
    setError(null);
    api<SessionDetail>("/sessions/" + id)
      .then(setD)
      .catch((e) => setError(String(e)));
  }, [id]);

  if (error) return <div className="error">{error}</div>;
  if (!d) return <div className="muted pad">Loading…</div>;
  const s = d.session;

  let lastTurn: string | null | undefined = undefined;
  // Events that actually render something (mirrors EventBlock's body check). A session with none
  // (e.g. a zero-turn session whose only line was a meta/command with no text) gets an empty-state
  // instead of a blank transcript area.
  const renderable = d.events.filter((e) => e.text || e.thinking || e.toolCalls.length);

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
          <span>{fmtTokens(s.tokens)} tok</span>
          <span>{fmtCost(s.cost)}</span>
          <span>{fmtDuration(s.duration_ms)}</span>
          <span className="muted">{fmtDate(s.started_at)}</span>
          <a className="export" href={`/api/sessions/${s.id}/export.md`}>
            ⬇ Export Markdown
          </a>
        </div>
        {d.classification && <ClassificationBadge c={d.classification} />}
      </div>

      <div className="transcript">
        {renderable.length === 0 && (
          <div className="muted pad" role="status">
            This session has no rendered messages.
          </div>
        )}
        {renderable.map((e) => {
          const turnBreak = e.turn_id !== lastTurn && e.turn_id != null;
          lastTurn = e.turn_id;
          const turn = turnBreak ? d.turns.find((t) => t.id === e.turn_id) : null;
          return (
            <div key={e.uuid}>
              {turn && (
                <div className="turn-sep">
                  turn {turn.seq + 1}
                  {turn.prompt_preview ? <span className="turn-preview"> · {turn.prompt_preview}</span> : null}
                </div>
              )}
              <EventBlock e={e} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
