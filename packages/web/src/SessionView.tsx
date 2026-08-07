import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { SessionHeader } from "./transcript/SessionHeader";
import { TranscriptToolbar } from "./transcript/TranscriptToolbar";
import { SearchBar } from "./transcript/SearchBar";
import { SubagentPanel } from "./transcript/Subagents";
import { TurnSection } from "./transcript/TurnSection";
import { EventBlock } from "./transcript/EventBlock";
import { groupByTurn } from "./transcript/group";
import { useSessionDetail } from "./transcript/useSessionDetail";
import { buildHaystacks, searchSession } from "./transcript/search";
import { useHighlightPaint } from "./transcript/useHighlightPaint";
import { useScrollToEvent } from "./transcript/useScrollToEvent";
import { useQueryState } from "./useQueryState";
import { useResetOn } from "./useResetOn";
import { ErrorAlert, Loading } from "./AsyncBoundary";
import {
  FlashContext,
  FormatContext,
  HideToolsContext,
  SearchContext,
  WorkflowMapContext,
  type MsgFormat,
} from "./transcript/contexts";
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

  // Events that actually render something (mirrors EventBlock's body check). A session with none
  // (e.g. a zero-turn session whose only line was a meta/command with no text) gets an empty-state
  // instead of a blank transcript area. Search runs over exactly this set, so a counted match is
  // always one the reader can be taken to.
  const renderable = useMemo(() => d?.events.filter((e) => e.text || e.thinking || e.toolCalls.length) ?? [], [d]);

  // Find in session. The whole transcript is already client-side, so this needs no request — and the
  // term lives in `?q=` so the view is shareable and can be handed over from the sessions list.
  const { get, set } = useQueryState();
  const query = get("q");
  const haystacks = useMemo(() => buildHaystacks(renderable), [renderable]);
  const model = useMemo(() => searchSession(renderable, haystacks, query), [renderable, haystacks, query]);

  // Deep link `#ev-<event_uuid>` (e.g. from a security finding row) and find-in-session's ◂/▸ are the
  // same jump. Keying the search position off the hash as well as the query means following a deep
  // link mid-search hands the transcript back to the hash rather than fighting it for the scroll.
  const hashUuid = /^#ev-(.+)$/.exec(hash)?.[1] ?? null;
  const [pos, setPos] = useResetOn(hash + "\n" + query, { idx: 0, seq: 0 });
  const activeHit = model.hits[pos.idx] ?? null;
  const targetUuid = activeHit?.uuid ?? hashUuid;
  // `seq` re-fires the jump when the index can't change — pressing ▸ on a session with one match.
  const token = activeHit ? `q:${query}:${pos.idx}:${pos.seq}` : hash || null;
  const flashUuid = useScrollToEvent(d?.events, targetUuid, token, collapsed, setCollapsed);

  // Wraps around at both ends. ◂/▸ are disabled with no matches, but Enter in the search box reaches
  // this too, where the modulo would be a division by zero — harmless today (`hits[NaN]` is undefined,
  // so the counter still reads "No matches") but not worth keeping NaN in state for.
  const step = (delta: number) => {
    if (!model.total) return;
    setPos((p) => ({ idx: (p.idx + delta + model.total) % model.total, seq: p.seq + 1 }));
  };

  const searchInput = useRef<HTMLInputElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  useHighlightPaint(transcriptRef, query);

  // `/` opens find-in-session, the convention in transcript and log readers. Ctrl+F is deliberately
  // left to the browser. Scoped to this view — the app has no global shortcut registry.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      e.preventDefault();
      searchInput.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const searchCtx = useMemo(
    () => ({ query, activeUuid: activeHit?.uuid ?? null }),
    [query, activeHit],
  );

  if (error) return <ErrorAlert error={error} />;
  if (!d) return <Loading />;

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
        search={
          <SearchBar
            query={query}
            onQuery={(q) => set({ q })}
            total={model.total}
            index={pos.idx}
            onPrev={() => step(-1)}
            onNext={() => step(1)}
            inputRef={searchInput}
          />
        }
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
      <SearchContext.Provider value={searchCtx}>
      <div className="transcript" ref={transcriptRef}>
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
              matches={model.byTurn.get(g.turnId as string) ?? 0}
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
      </SearchContext.Provider>
      </FlashContext.Provider>
      </HideToolsContext.Provider>
      </FormatContext.Provider>
      </WorkflowMapContext.Provider>
    </div>
  );
}
