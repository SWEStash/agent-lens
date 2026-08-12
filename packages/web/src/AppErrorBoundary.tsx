/**
 * Whole-app error boundary, with one case it handles specially: the tab that outlived a rebuild.
 *
 * Routes are `lazy()`, so their chunks load on first navigation — often long after the page did.
 * A rebuild in between replaces every hashed filename (`emptyOutDir`), so the chunk this document
 * names is simply gone and the `import()` rejects. Without a boundary that rejection reaches the
 * root and React unmounts the tree: a blank page, with only a MIME/module error in the console.
 *
 * The fix for a stale document is the obvious one — reload it, which fetches the current
 * index.html and its current chunk names. We do that once automatically (a marker in
 * sessionStorage stops a reload loop if the chunk is missing for some other reason) and otherwise
 * fall back to telling the user, which is also what any non-chunk render error gets.
 */
import React, { type ReactNode } from "react";

/** Browsers word a failed dynamic import differently; all three say the same thing. */
export function isStaleChunkError(error: unknown): boolean {
  const message = String((error as { message?: unknown } | null)?.message ?? error ?? "");
  return (
    /dynamically imported module/i.test(message) || // Chrome, Firefox
    /Importing a module script failed/i.test(message) || // Safari
    /Failed to load module script/i.test(message)
  );
}

const RELOAD_MARKER = "agent-lens:stale-chunk-reload";
/** A reload only fixes a stale document; if the chunk is still missing after one, reloading again
 *  just loops. Anything older than a minute is a different incident, so it may reload again. */
function mayAutoReload(): boolean {
  try {
    const at = Number(sessionStorage.getItem(RELOAD_MARKER));
    if (at && Date.now() - at < 60_000) return false;
    sessionStorage.setItem(RELOAD_MARKER, String(Date.now()));
    return true;
  } catch {
    return false; // storage disabled/partitioned — show the message instead of risking a loop
  }
}

type State = { error: Error | null; stale: boolean };

export class AppErrorBoundary extends React.Component<{ children: ReactNode }, State> {
  state: State = { error: null, stale: false };

  static getDerivedStateFromError(error: Error): State {
    return { error, stale: isStaleChunkError(error) };
  }

  componentDidCatch(error: Error) {
    if (isStaleChunkError(error) && mayAutoReload()) window.location.reload();
  }

  render() {
    const { error, stale } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="pad" role="alert">
        <div className="error">
          {stale
            ? "This page was loaded from an older build of Agent Lens and part of it is no longer on the server."
            : `Something went wrong rendering this view: ${error.message}`}
        </div>
        <button type="button" className="ghost" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
