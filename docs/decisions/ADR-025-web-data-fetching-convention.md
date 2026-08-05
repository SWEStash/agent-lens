# ADR-025 — One data-fetching and URL-state convention for the SPA

- Status: Accepted
- Date: 2026-07-25
- Deciders: project owner

## Context

The SPA has no data-fetching library. Every view reached for `api()` directly and grew its own copy
of the same machinery:

- **Loading/error state.** Nine views declared `data`/`loading`/`error` as three `useState` slots and
  ran the same effect: set loading, clear error, fetch, set data or set error, clear loading. Each
  also carried its own copy of the `Loading…` and error markup, including the ARIA roles — so an
  accessibility fix had to be applied nine times, and two views had already drifted.
- **The same race, nine times.** None of the copies guarded against out-of-order responses: change a
  filter twice quickly and a slow earlier request could overwrite the newer rows, or replace them
  with its own error.
- **URL-backed view state.** Filters, sort and paging live in the URL so a view is shareable and the
  back button works. Six views re-implemented "read a param with a fallback", "patch the query"
  (empty value deletes; on paged views also drop `offset`, unless the patch is *setting* offset), and
  "collect the active filters into the request's query string".

Both were deferred earlier for the same reason: `packages/web` had no test harness, so there was no
way to prove a shared hook behaved like the nine hand-rolled copies it replaced.

## Decision

**Adopt one fetching hook and one URL-state hook, and give the web package a real test project so
they can be pinned.**

- `useAsync(load, deps, opts)` owns the loading/error state machine. `load` may return `null` for
  "nothing to fetch" (a route param that isn't there yet). `opts.reset` clears the previous payload
  on a dep change — detail pages want that (don't show the outgoing record), list pages want the
  opposite (keep the old rows under a loading line). The effect's cleanup marks the in-flight request
  stale, which is where the out-of-order fix lives, once.
- `useFetch(path, opts)` is the one-GET case; `useLookup(path, fallback, deps)` is the
  fire-and-forget filter-dropdown case, whose failures stay silent (a missing filter list must not
  break the page) and whose fallback is identity-stable so it is safe in a dep array.
- `Loading`, `ErrorAlert` and `AsyncBoundary` own the markup. `AsyncBoundary` is the render-prop form
  for detail pages: the page body moves into a component that takes the loaded record as a prop, so
  it never renders against a half-loaded state.
- `useQueryState(resetOnChange)` owns the URL state: `get`/`set`/`pick`/`clear`. The reset-key rule
  that used to be an `if (key !== "offset")` buried in each view's `setParam` is now declared at the
  call site that needs it.
- `packages/web/vitest.config.ts` defines the web test project (jsdom + `@vitejs/plugin-react`,
  source resolved by vite). The root config references it, so `pnpm test` and
  `pnpm --filter @agent-lens/web test` run exactly the same tests.

Rejected: adopting React Query / SWR. It would solve more than we have (caching, revalidation,
mutations) at the cost of a dependency in a local-first, single-user app whose data changes only when
the user re-ingests. The hook is ~50 lines and testable.

## Consequences

- A new view is `const { data, loading, error } = useFetch<T>(path)` plus `<ErrorAlert>`/`<Loading>`,
  and gets the race fix for free. Adding a data-fetching concern (retry, a spinner delay, an
  in-memory cache) is now one file instead of nine.
- The hooks are unit-tested (loading/error transitions, keep-vs-reset, null path, stale-response
  handling, the reset-key rules). Hook and component tests are possible at all now, which is what
  unblocked this ADR's work in the first place.
- `useSessionDetail` (the transcript loader from the phase-3 split) sits on `useFetch` too, so there
  is exactly one fetch state machine in the package.
- The SPA keeps hand-rolled data fetching. If server state ever grows mutations and cache
  invalidation beyond triage's `reloadKey` bump, revisit the library decision rather than growing
  `useAsync` into one.
