/** The five contexts the transcript tree reads: message format, the Workflow tool-use -> run-id map,
 * the hide-tools toggle, the deep-link flash target, and the active search. Provided once by
 * SessionView. */
import { createContext } from "react";

/** How message bodies render: "markdown" (formatted, the default) or "raw" (verbatim text).
 * Provided once per SessionView and consumed deep in the tree by message bodies. */
export type MsgFormat = "markdown" | "raw";

export const FormatContext = createContext<MsgFormat>("markdown");

/** Maps a Workflow tool_use id → its run id (wf_…), built once per SessionView from the transcript's
 * tool calls. Lets a `<task-notification>` (which carries the originating tool-use-id) link straight
 * to the workflow detail page. Tasks with no matching Workflow tool_call (e.g. a plain Agent spawn)
 * just won't resolve a link. */
export const WorkflowMapContext = createContext<Map<string, string>>(new Map());

/** When true, mechanical tool-call chips (Bash, Edit, Skill, Read, …) are hidden so the transcript
 * reads as just the human-facing conversation. Plans and AskUserQuestion Q&A are kept regardless —
 * they're part of that conversation, not tool noise. */
export const HideToolsContext = createContext<boolean>(false);

// event uuid of a deep-linked message to flash (from #ev-<uuid>); null = none. Owned by SessionView so
// the highlight survives re-renders (e.g. expanding the target's turn).
export const FlashContext = createContext<string | null>(null);

/** The live find-in-session term and the message ◂/▸ currently sit on. Read by the two components
 * that hide text a match could be buried in — the thinking toggle and the long-body clamp — so they
 * can open themselves when the reader navigates to them. `query` alone isn't enough: opening every
 * clamped body that happens to contain the term would expand half the transcript at once. */
export const SearchContext = createContext<{ query: string; activeUuid: string | null }>({
  query: "",
  activeUuid: null,
});
