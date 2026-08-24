/**
 * The band is a bespoke SVG, so every affordance a native control would have given us is hand-built
 * and has to be held in place by tests: one tab stop, a roving cursor, Enter to open, Shift+arrows to
 * select, and an announcement carrying what colour and height cannot.
 *
 * jsdom has no ResizeObserver, and the band renders nothing until it has measured a width — so the
 * stub below is what makes the SVG exist at all here. Without it these tests would pass vacuously.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventNode } from "../src/api";
import { TimelineBand } from "../src/transcript/timeline/TimelineBand";

const WIDTH = 1000;
/** Mirrors HOVER_RADIUS_PX in the component. */
const HOVER_RADIUS = 12;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private cb: ResizeObserverCallback) {}
      observe() {
        this.cb([{ contentRect: { width: WIDTH } }] as unknown as ResizeObserverEntry[], this as never);
      }
      disconnect() {}
      unobserve() {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

const ev = (uuid: string, minute: number, extra: Partial<EventNode> = {}): EventNode =>
  ({
    uuid,
    type: "assistant",
    role: "assistant",
    timestamp: `2026-01-01T10:${String(minute).padStart(2, "0")}:00Z`,
    model: null,
    is_sidechain: 0,
    turn_id: "t1",
    text: `body ${uuid}`,
    thinking: null,
    toolCalls: [],
    ...extra,
  }) as EventNode;

const EVENTS = [
  ev("a", 0, { role: "user" }),
  ev("b", 1, { usage: { input: 10, output: 4190, cache_creation: 0, cache_read: 0 } }),
  ev("c", 2),
  ev("d", 3),
];

function setup(over: Partial<Parameters<typeof TimelineBand>[0]> = {}) {
  const onRange = vi.fn();
  const onJump = vi.fn();
  const props = {
    events: EVENTS,
    findings: [],
    fileChanges: [],
    axisMode: "compressed" as const,
    onAxisMode: vi.fn(),
    metric: "work" as const,
    onMetric: vi.fn(),
    range: null,
    onRange,
    onJump,
    domain: null,
    onDomain: vi.fn(),
    ...over,
  };
  render(<TimelineBand {...props} />);
  const svg = document.querySelector(".tl-svg") as SVGSVGElement;
  const live = document.querySelector("[aria-live]") as HTMLElement;
  return { svg, live, onRange, onJump };
}

describe("timeline band hover", () => {
  // The marks are 2-3px wide and carry only colour and height, so without this the reader is asked to
  // click or brush a target they cannot identify.
  const hoverAt = (svg: SVGSVGElement, clientX: number) => fireEvent.pointerMove(svg, { clientX, clientY: 20 });

  it("names the message under the pointer: turn, type, time and size", () => {
    const { svg } = setup({ turnSeqById: new Map([["t1", 1]]) });
    hoverAt(svg, 0);
    const tip = document.querySelector(".tl-tip") as HTMLElement;
    expect(tip).toBeTruthy();
    expect(tip.textContent).toMatch(/turn 2/);
    expect(tip.textContent).toMatch(/user/);
  });

  it("shows the token count on a message that has one", () => {
    const { svg } = setup();
    // The second mark carries usage; the band is 1000px wide over four evenly spaced messages.
    hoverAt(svg, 333);
    expect(document.querySelector(".tl-tip")?.textContent).toMatch(/4\.2k tok/);
  });

  it("highlights the mark it is describing", () => {
    const { svg } = setup();
    hoverAt(svg, 0);
    expect(document.querySelector(".tl-hover")).toBeTruthy();
  });

  it("covers the whole mark, not just where it starts", () => {
    // An assistant or tool message that occupied real time renders as a wide bar. Measuring from its
    // leading edge left most of that bar dead to both hover and click.
    // Consecutive minutes, so nothing is collapsed and the middle message really does span half the
    // axis. A gap over the idle threshold would make it a 2px tick and the test would prove nothing.
    const long = [
      ev("u", 0, { role: "user" }),
      ev("wide", 1, { usage: { input: 0, output: 100, cache_creation: 0, cache_read: 0 } }),
      ev("end", 2),
    ];
    const { svg } = setup({ events: long });
    const bar = [...document.querySelectorAll(".tl-mark")].map((n) => ({
      x: +n.getAttribute("x")!,
      w: +n.getAttribute("width")!,
    }))[1];
    expect(bar.w).toBeGreaterThan(HOVER_RADIUS + 1); // otherwise this proves nothing

    // Its far end is well beyond the hover radius measured from the start.
    hoverAt(svg, bar.x + bar.w - 1);
    expect(document.querySelector(".tl-tip")).toBeTruthy();
    // And the highlight spans the bar rather than sitting on its edge.
    const hl = document.querySelector(".tl-hover")!;
    expect(+hl.getAttribute("width")!).toBeGreaterThanOrEqual(bar.w);
  });

  it("ignores the pointer when it is nowhere near a mark", () => {
    const { svg } = setup({ events: [EVENTS[0], EVENTS[3]] });
    hoverAt(svg, 500); // midway between two marks 1000px apart
    expect(document.querySelector(".tl-tip")).toBeNull();
  });

  it("clears when the pointer leaves the band", () => {
    const { svg } = setup();
    hoverAt(svg, 0);
    expect(document.querySelector(".tl-tip")).toBeTruthy();
    fireEvent.pointerLeave(svg);
    expect(document.querySelector(".tl-tip")).toBeNull();
  });

  it("flips to the right edge past the midpoint so it cannot run off the band", () => {
    const { svg } = setup();
    hoverAt(svg, 1000);
    expect(document.querySelector(".tl-tip")?.className).toMatch(/is-right/);
    hoverAt(svg, 0);
    expect(document.querySelector(".tl-tip")?.className).not.toMatch(/is-right/);
  });

  it("does not fight a drag for the pointer", () => {
    const { svg, onRange } = setup();
    fireEvent.pointerDown(svg, { button: 0, clientX: 0, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 600, clientY: 20, pointerId: 1 });
    expect(document.querySelector(".tl-tip")).toBeNull();
    expect(onRange).toHaveBeenCalled();
  });
});

describe("timeline band degraded states", () => {
  it("with no usage anywhere, falls back to uniform heights and hides the metric control", () => {
    // A newer page served by a server that predates per-event usage. It must still do its navigation
    // job rather than drawing a row of zero-height marks — and offering a token metric to choose
    // between would be offering a choice that changes nothing.
    setup({ events: EVENTS.map(({ usage: _u, ...e }) => e as EventNode) });
    expect(document.querySelector(".tl-ctl")).toBeNull();
    const heights = [...document.querySelectorAll(".tl-mark")].map((n) => n.getAttribute("height"));
    expect(new Set(heights).size).toBe(1);
    expect(document.querySelectorAll(".tl-mark")).toHaveLength(4);
  });

  it("says so plainly when a session has no timing data at all", () => {
    setup({ events: EVENTS.map((e) => ({ ...e, timestamp: null })) });
    expect(screen.getByText(/no timing data for this session/i)).toBeTruthy();
    expect(document.querySelector(".tl-svg")).toBeNull();
  });

  it("renders nothing at all when there are no events", () => {
    setup({ events: [] });
    expect(document.querySelector(".timeline")).toBeNull();
  });

  it("places a single-message session without a brush", () => {
    setup({ events: [EVENTS[0]] });
    expect(document.querySelectorAll(".tl-mark")).toHaveLength(1);
    expect(screen.getByText(/^1 message$/)).toBeTruthy();
  });

  it("lists only the message types the session actually contains", () => {
    // "thinking" can never occur on a Claude Code transcript — those blocks arrive with their text
    // stripped — so a fixed legend would advertise a category that cannot appear.
    setup();
    const legend = [...document.querySelectorAll(".tl-key")].map((n) => n.textContent.trim());
    expect(legend).toContain("user");
    expect(legend).toContain("assistant");
    expect(legend).not.toContain("thinking");
    expect(legend).not.toContain("tool error");
  });
});

describe("timeline band keyboard support", () => {
  it("renders the svg once a width is measured", () => {
    const { svg } = setup();
    expect(svg).toBeTruthy();
    expect(document.querySelectorAll(".tl-mark")).toHaveLength(4);
  });

  it("is a single tab stop with an accessible name that explains the keys", () => {
    const { svg } = setup();
    expect(svg.getAttribute("tabindex")).toBe("0");
    expect(document.querySelectorAll('.timeline [tabindex="0"]')).toHaveLength(1);
    expect(svg.getAttribute("aria-label")).toMatch(/arrow keys/i);
  });

  it("announces the cursor: position, type, tokens and time", () => {
    const { svg, live } = setup();
    expect(live.textContent).toMatch(/message 1 of 4, user/);
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    // The second message carries usage, so its size is spoken too — height alone cannot convey it.
    expect(live.textContent).toMatch(/message 2 of 4, assistant, 4\.2k tokens/);
  });

  it("does not use role=status, which the search counter already owns on this page", () => {
    const { live } = setup();
    expect(live.getAttribute("role")).toBeNull();
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.getAttribute("aria-atomic")).toBe("true");
  });

  it("moves with arrows and jumps to the ends with Home/End, stopping at the edges", () => {
    const { svg, live } = setup();
    fireEvent.keyDown(svg, { key: "ArrowLeft" }); // already at the start
    expect(live.textContent).toMatch(/message 1 of 4/);
    fireEvent.keyDown(svg, { key: "End" });
    expect(live.textContent).toMatch(/message 4 of 4/);
    fireEvent.keyDown(svg, { key: "ArrowRight" }); // already at the end
    expect(live.textContent).toMatch(/message 4 of 4/);
    fireEvent.keyDown(svg, { key: "Home" });
    expect(live.textContent).toMatch(/message 1 of 4/);
  });

  it("opens the cursor's message with Enter", () => {
    const { svg, onJump } = setup();
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    fireEvent.keyDown(svg, { key: "Enter" });
    expect(onJump).toHaveBeenCalledWith("b");
  });

  it("extends a selection from the anchor with Shift+arrows", () => {
    const { svg, onRange } = setup();
    fireEvent.keyDown(svg, { key: "ArrowRight" }); // cursor on `b`, no selection yet
    expect(onRange).not.toHaveBeenCalled();
    fireEvent.keyDown(svg, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(svg, { key: "ArrowRight", shiftKey: true });
    // Anchored where the extension began, not where the cursor started out.
    expect(onRange).toHaveBeenLastCalledWith([Date.parse("2026-01-01T10:01:00Z"), Date.parse("2026-01-01T10:03:00Z")]);
  });

  it("a plain arrow after an extension drops the anchor", () => {
    const { svg, onRange } = setup();
    fireEvent.keyDown(svg, { key: "ArrowRight", shiftKey: true });
    onRange.mockClear();
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    expect(onRange).not.toHaveBeenCalled();
  });

  it("clears the selection on Escape without touching the zoom domain", () => {
    const onDomain = vi.fn();
    const { onRange } = setup({ range: [Date.parse("2026-01-01T10:00:00Z"), Date.parse("2026-01-01T10:02:00Z")], onDomain });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onRange).toHaveBeenCalledWith(null);
    expect(onDomain).not.toHaveBeenCalled();
  });

  it("hides the axis toggle when the session has no idle gaps to collapse", () => {
    // True for 96% of subagent sessions: compressed and literal would render identically.
    setup();
    expect(screen.queryByRole("button", { name: /time/i })).toBeNull();
  });

  it("keeps the axis toggle reachable in literal mode, so the choice is reversible", () => {
    // Literal mode collapses nothing, so a toggle keyed off the drawn breaks would vanish the moment
    // it was used, stranding the reader on literal with no way back.
    const gapped = [ev("a", 0), ev("b", 1), ev("c", 40), ev("d", 41)];
    for (const mode of ["compressed", "literal"] as const) {
      cleanup();
      setup({ events: gapped, axisMode: mode });
      expect(screen.getByRole("button", { name: /time/i })).toBeTruthy();
    }
  });

  it("keeps it reachable when every gap has been opened in place", () => {
    const gapped = [ev("a", 0), ev("b", 1), ev("c", 40), ev("d", 41)];
    const { svg } = setup({ events: gapped });
    const gap = document.querySelector(".tl-break") as SVGGElement;
    fireEvent.dblClick(gap);
    expect(document.querySelectorAll(".tl-break")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /time/i })).toBeTruthy();
    expect(svg).toBeTruthy();
  });
});
