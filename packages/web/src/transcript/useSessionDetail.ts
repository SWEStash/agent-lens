/** Loads one session's transcript payload and derives the Workflow tool-use → run-id map from it.
 * Refetches whenever the id changes, clearing the previous session's data first (`reset`) so the page
 * shows its loading state rather than the outgoing transcript. */
import { useMemo } from "react";
import type { SessionDetail } from "../api";
import { useFetch } from "../useFetch";

export function useSessionDetail(id: string | undefined) {
  const { data: d, error } = useFetch<SessionDetail>("/sessions/" + id, { reset: true });

  // tool-use-id → workflow run id, so a `<task-notification>` can link to its workflow detail page.
  const wfMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of d?.events ?? [])
      for (const t of e.toolCalls)
        if (t.tool_name === "Workflow" && t.id && t.workflow_run_id) m.set(t.id, t.workflow_run_id);
    return m;
  }, [d]);

  return { d, error, wfMap };
}
