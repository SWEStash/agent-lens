import { useEffect, useRef, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { SessionHeader } from "./transcript/SessionHeader";
import { TranscriptToolbar } from "./transcript/TranscriptToolbar";
import { SubagentPanel } from "./transcript/Subagents";
import { TurnSection } from "./transcript/TurnSection";
import { EventBlock } from "./transcript/EventBlock";
import { groupByTurn } from "./transcript/group";
import { useSessionDetail } from "./transcript/useSessionDetail";
import { ErrorAlert, Loading } from "./AsyncBoundary";
import { FlashContext, FormatContext, HideToolsContext, WorkflowMapContext, type MsgFormat } from "./transcript/contexts";
import { fetchViewPrefs, loadFormat, loadHideTools, saveFormat, saveHideTools } from "./transcript/viewPrefs";

export default function SessionView() {
  const { id } = useParams();
  const { hash } = useLocation();
  const { d, error, wfMap } = useSessionDetail(id);
  // Turn ids that are collapsed. Empty = all expanded (preserves the prior always-open behavior).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // How message bodies render. Defaults to markdown; persisted so the choice sticks across sessions.
  const [format, setFormat] = useState<MsgFormat>(loadFormat);
  // Hide mechanical tool chips to read only the human-facing conversation. Persisted like format.
  const [hideTools, setHideTools] = useState<boolean>(loadHideTools);

  useEffect(() => setCollapsed(new Set()), [id]);

  // Painted from the localStorage cache above; reconcile with the server's stored value (source of
  // truth when a writable store is configured), like the dashboard/sessions prefs do.
  useEffect(() => {
    void fetchViewPrefs().then((p) => {
      if (p.format !== undefined) setFormat(p.format);
      if (p.hideTools !== undefined) setHideTools(p.hideTools);
    });
  }, []);

  const chooseFormat = (f: MsgFormat) => {
    setFormat(f);
    saveFormat(f);
  };

  const toggleHideTools = () =>
    setHideTools((h) => {
      saveHideTools(!h);
      return !h;
    });

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

  if (error) return <ErrorAlert error={error} />;
  if (!d) return <Loading />;

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
      <SessionHeader d={d} />

      {d.children && d.children.length > 0 && <SubagentPanel d={d} />}

      <TranscriptToolbar
        turnCount={collapsibleIds.length}
        anyOpen={anyOpen}
        onToggleAll={() => setCollapsed(anyOpen ? new Set(collapsibleIds) : new Set())}
        hideTools={hideTools}
        onToggleHideTools={toggleHideTools}
        format={format}
        onChooseFormat={chooseFormat}
      />

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
