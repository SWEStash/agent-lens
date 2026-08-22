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
import { buildHaystacks, searchSession, MIN_QUERY } from "./transcript/search";
import { useHighlightPaint } from "./transcript/useHighlightPaint";
import { useScrollToEvent } from "./transcript/useScrollToEvent";
import { useQueryState } from "./useQueryState";
import { useResetOn } from "./useResetOn";
import { ErrorAlert, Loading } from "./AsyncBoundary";
import {
  FlashContext,
  FormatContext,
  HideToolsContext,
  JumpTargetContext,
  SearchContext,
  WorkflowMapContext,
  type MsgFormat,
} from "./transcript/contexts";
import {
  fetchViewPrefs,
  loadAxisMode,
  loadFormat,
  loadHideTools,
  loadTimelineMetric,
  saveAxisMode,
  saveFormat,
  saveHideTools,
  saveTimelineMetric,
  type AxisMode,
} from "./transcript/viewPrefs";
import { TimelineBand } from "./transcript/timeline/TimelineBand";
import BackToTop from "./BackToTop";
import { fmtClock } from "./format";
import type { TokenMetric } from "./transcript/timeline/marks";

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
  // Timeline band: axis mode and which token number drives mark height. Persisted the same way.
  const [axisMode, setAxisMode] = useState<AxisMode>(loadAxisMode);
  const [metric, setMetric] = useState<TokenMetric>(loadTimelineMetric);

  useEffect(() => setCollapsed(new Set()), [id]);

  // Painted from the localStorage cache above; reconcile with the server's stored value (source of
  // truth when a writable store is configured), like the dashboard/sessions prefs do.
  useEffect(() => {
    void fetchViewPrefs().then((p) => {
      if (p.format !== undefined) setFormat(p.format);
      if (p.hideTools !== undefined) setHideTools(p.hideTools);
      if (p.axisMode !== undefined) setAxisMode(p.axisMode);
      if (p.metric !== undefined) setMetric(p.metric);
    });
  }, []);

  const chooseFormat = (f: MsgFormat) => {
    setFormat(f);
    saveFormat(f);
  };

  const chooseAxisMode = (m: AxisMode) => {
    setAxisMode(m);
    saveAxisMode(m);
  };

  const chooseMetric = (m: TokenMetric) => {
    setMetric(m);
    saveTimelineMetric(m);
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

  // The timeline's selection hard-filters the transcript, and lives in the URL beside `?q=` so a
  // narrowed view is shareable. Zoom (`domain`) is deliberately NOT in the URL: it changes what the
  // axis shows, not what the reader is looking at.
  const range = useMemo((): [number, number] | null => {
    const from = Date.parse(get("from"));
    const to = Date.parse(get("to"));
    return Number.isNaN(from) || Number.isNaN(to) ? null : [from, to];
  }, [get]);
  // Replaced, never pushed: the band writes this on every pointer move while a range is being
  // dragged, so pushing would bury the previous page under a history entry per mouse move.
  const setRange = (r: [number, number] | null) =>
    set(r ? { from: new Date(r[0]).toISOString(), to: new Date(r[1]).toISOString() } : { from: "", to: "" }, {
      replace: true,
    });
  const [domain, setDomain] = useState<[number, number] | null>(null);
  useEffect(() => setDomain(null), [id]);

  // renderable -> time-range filter -> search, so a match count always describes what is on screen.
  // An event with NO timestamp is never filtered out: it cannot be placed on the axis, and hiding it
  // would make it unreachable.
  const visible = useMemo(() => {
    if (!range) return renderable;
    return renderable.filter((e) => {
      if (!e.timestamp) return true;
      const t = Date.parse(e.timestamp);
      return Number.isNaN(t) || (t >= range[0] && t <= range[1]);
    });
  }, [renderable, range]);

  const haystacks = useMemo(() => buildHaystacks(visible), [visible]);
  const model = useMemo(() => searchSession(visible, haystacks, query), [visible, haystacks, query]);

  // Deep link `#ev-<event_uuid>` (e.g. from a security finding row) and find-in-session's ◂/▸ are the
  // same jump. Keying the search position off the hash as well as the query means following a deep
  // link mid-search hands the transcript back to the hash rather than fighting it for the scroll.
  const hashUuid = /^#ev-(.+)$/.exec(hash)?.[1] ?? null;
  const [pos, setPos] = useResetOn(hash + "\n" + query, { idx: 0, seq: 0 });
  const activeHit = model.hits[pos.idx] ?? null;
  // Clicking a timeline mark is the third caller of the same jump, after `#ev-` deep links and
  // find-in-session's arrows. `nonce` re-fires it when the same mark is clicked twice.
  const [banded, setBanded] = useState<{ uuid: string; nonce: number } | null>(null);
  useEffect(() => setBanded(null), [id]);
  const jumpTo = (uuid: string) => setBanded((b) => ({ uuid, nonce: (b?.nonce ?? 0) + 1 }));

  // A search that matches nothing leaves the reader wherever the last match had scrolled them, with
  // no sign that the view no longer relates to what they typed. Return to the top, where the box and
  // its "No matches" sit, so the result of the keystroke is visible.
  const noMatches = query.trim().length >= MIN_QUERY && model.total === 0;
  useEffect(() => {
    if (!noMatches) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  }, [noMatches, query]);
  const targetUuid = banded?.uuid ?? activeHit?.uuid ?? hashUuid;
  // `seq` re-fires the jump when the index can't change — pressing ▸ on a session with one match.
  // The range is part of the deep-link token: a target outside the range isn't in the DOM yet, so the
  // first attempt finds nothing. Clearing the range (below) changes the token, which is what re-fires
  // the jump once the message is actually rendered.
  const token = banded
    ? `band:${banded.uuid}:${banded.nonce}`
    : activeHit
      ? `q:${query}:${pos.idx}:${pos.seq}`
      : hash
        ? `${hash}${range ? ":ranged" : ""}`
        : null;
  const flashUuid = useScrollToEvent(d?.events, targetUuid, token, collapsed, setCollapsed);

  // A deep link must always land: if `#ev-<uuid>` points outside the active range, drop the range
  // first, and say so, rather than scrolling to a message the filter is hiding.
  const [rangeCleared, setRangeCleared] = useState(false);
  useEffect(() => {
    if (!hashUuid || !range || !d) return;
    const target = d.events.find((e) => e.uuid === hashUuid);
    const t = target?.timestamp ? Date.parse(target.timestamp) : NaN;
    if (Number.isNaN(t) || (t >= range[0] && t <= range[1])) return;
    set({ from: "", to: "" });
    setRangeCleared(true);
    // Drive the jump explicitly rather than leaving it to the hash: patching the query navigates, and
    // that drops the URL fragment, so `#ev-<uuid>` is gone by the time the message is on screen.
    jumpTo(hashUuid);
  }, [hashUuid, range, d, set]);
  useEffect(() => {
    if (!rangeCleared) return;
    const t = window.setTimeout(() => setRangeCleared(false), 6000);
    return () => window.clearTimeout(t);
  }, [rangeCleared]);

  // Wraps around at both ends. ◂/▸ are disabled with no matches, but Enter in the search box reaches
  // this too, where the modulo would be a division by zero — harmless today (`hits[NaN]` is undefined,
  // so the counter still reads "No matches") but not worth keeping NaN in state for.
  const step = (delta: number) => {
    if (!model.total) return;
    setPos((p) => ({ idx: (p.idx + delta + model.total) % model.total, seq: p.seq + 1 }));
  };

  // The document listener below is bound once on mount, so it reads the current stepper through a ref
  // rather than closing over a render's copy.
  const stepRef = useRef({ step, total: model.total });
  stepRef.current = { step, total: model.total };

  const searchInput = useRef<HTMLInputElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  useHighlightPaint(transcriptRef, query);

  // `/` opens find-in-session, the convention in transcript and log readers. Ctrl+F is deliberately
  // left to the browser. Scoped to this view — the app has no global shortcut registry.
  //
  // Enter / Shift+Enter also step here, but only while nothing at all has focus: scrolling with the
  // wheel leaves focus on <body>, where Enter means nothing, and requiring a click on the pill first
  // is the friction this is here to remove. Anything focusable keeps its own Enter — the search UI's
  // own containers handle their case (transcript/searchKeys.ts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // React's handlers are bound inside document and so have already run and, if they acted, called
      // preventDefault. Without this, a key handled by the search UI would step a second time here.
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchInput.current?.focus();
        return;
      }
      // Asked of `activeElement`, not the event target: the two agree in a browser, but only the
      // former actually answers "does anything hold focus right now".
      const active = document.activeElement;
      const unfocused = !active || active === document.body || active === document.documentElement;
      if (e.key === "Enter" && unfocused && stepRef.current.total) {
        e.preventDefault();
        stepRef.current.step(e.shiftKey ? -1 : 1);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Turn id -> its number, so a hovered timeline mark can say which turn it belongs to.
  const turnSeqById = useMemo(
    () => new Map((d?.turns ?? []).map((t) => [t.id, t.seq])),
    [d],
  );

  // Which events are REAL human prompts (as opposed to tool results, which also carry role "user").
  const userPromptUuids = useMemo(
    () => new Set((d?.turns ?? []).map((t) => t.user_event_uuid).filter((u): u is string => !!u)),
    [d],
  );

  const searchCtx = useMemo(
    () => ({ query, activeUuid: activeHit?.uuid ?? null }),
    [query, activeHit],
  );

  if (error) return <ErrorAlert error={error} />;
  if (!d) return <Loading />;

  const groups = groupByTurn(visible, d.turns);
  // Unfiltered per-turn totals, so a partially-filtered turn can say "3 of 11".
  const turnTotals = new Map<string, number>();
  for (const e of renderable) if (e.turn_id) turnTotals.set(e.turn_id, (turnTotals.get(e.turn_id) ?? 0) + 1);
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

      <TimelineBand
        events={renderable}
        findings={d.findings}
        fileChanges={d.file_changes}
        userPromptUuids={userPromptUuids}
        turnSeqById={turnSeqById}
        axisMode={axisMode}
        onAxisMode={chooseAxisMode}
        metric={metric}
        onMetric={chooseMetric}
        range={range}
        onRange={setRange}
        onJump={jumpTo}
        domain={domain}
        onDomain={setDomain}
      />

      {rangeCleared && (
        <div className="tl-pill muted" role="status">
          Range cleared to show the linked message.
        </div>
      )}

      {range && (
        <div className="tl-pill" role="status">
          <span className="tl-pill-range">
            {fmtClock(range[0])}–{fmtClock(range[1])}
          </span>
          <span className="muted">
            {visible.length === 0
              ? "no messages in this range"
              : `showing ${visible.length} of ${renderable.length} messages`}
          </span>
          {domain ? (
            <button type="button" className="link-btn" onClick={() => setDomain(null)}>
              ◂ full session
            </button>
          ) : (
            <button type="button" className="link-btn" onClick={() => setDomain(range)}>
              ⤢ zoom
            </button>
          )}
          <button type="button" className="link-btn" onClick={() => setRange(null)}>
            clear ✕
          </button>
        </div>
      )}

      {d.children && d.children.length > 0 && <SubagentPanel d={d} />}

      <TranscriptToolbar
        search={
          <SearchBar
            query={query}
            // Replaced rather than pushed: the term is debounced but still lands per word, and one
            // history entry per keystroke makes Back walk the query back a letter at a time instead
            // of leaving the page.
            onQuery={(q) => set({ q }, { replace: true })}
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
      <JumpTargetContext.Provider value={targetUuid}>
      <FlashContext.Provider value={flashUuid}>
      <SearchContext.Provider value={searchCtx}>
      <div className="transcript" ref={transcriptRef}>
        {renderable.length === 0 && (
          <div className="muted pad" role="status">
            This session has no rendered messages.
          </div>
        )}
        {renderable.length > 0 && visible.length === 0 && (
          <div className="muted pad" role="status">
            No messages in the selected time range.
          </div>
        )}
        {groups.map((g, i) =>
          g.turn ? (
            <TurnSection
              key={g.turnId}
              turn={g.turn}
              events={g.events}
              matches={model.byTurn.get(g.turnId as string) ?? 0}
              total={turnTotals.get(g.turnId as string)}
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
      </JumpTargetContext.Provider>
      </HideToolsContext.Provider>
      </FormatContext.Provider>
      </WorkflowMapContext.Provider>

      <BackToTop />
    </div>
  );
}
