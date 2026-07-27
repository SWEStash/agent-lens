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
  // view and flash it. The target is derived from the hash rather than stored.
  const targetUuid = /^#ev-(.+)$/.exec(hash)?.[1] ?? null;
  const [flashUuid, setFlashUuid] = useState<string | null>(null);

  // If the target sits in a collapsed turn, open that turn — the same one-time edit clicking its header
  // would make, so the reader can collapse it again afterwards. Returning `prev` unchanged when there
  // is nothing to open keeps this from queueing a pointless render.
  useEffect(() => {
    const turnId = targetUuid ? d?.events.find((e) => e.uuid === targetUuid)?.turn_id : null;
    if (!turnId) return;
    setCollapsed((prev) => {
      if (!prev.has(turnId)) return prev;
      const next = new Set(prev);
      next.delete(turnId);
      return next;
    });
  }, [d, targetUuid]);

  // Scroll + flash once the target is actually in the DOM, which the effect above may have just caused.
  // This one only READS `collapsed` — previously a single effect wrote to it to re-trigger itself, and
  // the ref existed to absorb the extra passes that caused (SLOP-062). It is now a plain once-per-hash
  // guard: re-navigating to the same hash should not re-scroll, but a later expansion should still be
  // able to complete a scroll that had no element to find yet.
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!d || !targetUuid) {
      scrolledFor.current = null;
      return;
    }
    if (scrolledFor.current === hash) return;
    const el = document.getElementById("ev-" + targetUuid);
    if (!el) return;
    scrolledFor.current = hash;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlashUuid(targetUuid);
    const t = window.setTimeout(() => setFlashUuid(null), 3000);
    return () => window.clearTimeout(t);
  }, [d, hash, targetUuid, collapsed]);

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
