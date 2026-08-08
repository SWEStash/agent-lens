/** How a view renders a `useFetch` state. These two elements (and their ARIA roles) live here once,
 * rather than being copied into every page. */
import type { ReactNode } from "react";
import type { AsyncState } from "./useFetch";

/** The in-flight line. `role=status` + `aria-live=polite` so a screen reader announces the wait. */
export function Loading() {
  return (
    <div className="muted pad" role="status" aria-live="polite">
      Loading…
    </div>
  );
}

/** The failed-load line; renders nothing when there is no error, so callers can drop it in bare. */
export function ErrorAlert({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <div className="error" role="alert">
      {error}
    </div>
  );
}

/** The whole-page form a detail view uses: nothing renders until the record is in hand. `empty` shows
 * when the load finished without one (a bad id, or no id at all); it defaults to the loading line,
 * for views where that state is unreachable. */
export function AsyncBoundary<T>({
  state,
  empty,
  children,
}: {
  state: AsyncState<T>;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (state.error) return <ErrorAlert error={state.error} />;
  if (state.loading) return <Loading />;
  if (!state.data) return <>{empty ?? <Loading />}</>;
  return <>{children(state.data)}</>;
}
