/** Loads one session's transcript payload and derives the Workflow tool-use → run-id map from it.
 * Refetches whenever the id changes, clearing the previous session's data first so the page shows its
 * loading state rather than the outgoing transcript. */
import { useEffect, useMemo, useState } from "react";
import { api, type SessionDetail } from "../api";

export function useSessionDetail(id: string | undefined) {
  const [d, setD] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setD(null);
    setError(null);
    api<SessionDetail>("/sessions/" + id)
      .then(setD)
      .catch((e) => setError(String(e)));
  }, [id]);

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
