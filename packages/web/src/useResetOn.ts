import { useState } from "react";

/**
 * State that returns to `initial` whenever `key` changes.
 *
 * The effect form of this — `useEffect(() => setPageNum(1), [filter])` — is React's documented
 * anti-pattern for derived resets: the stale value is committed and painted first, and only then does
 * the effect fire a second render to correct it, so the user can see page 3 of a filter that has one
 * page. This uses the sanctioned alternative instead (adjusting state during render): React discards
 * the in-progress render and immediately re-runs with the reset value, before anything is committed.
 *
 * `key` should be a stable string identity of "what this state belongs to" — a serialized filter, a
 * row id. Set values normally; the next render under a different `key` discards them.
 */
export function useResetOn<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(initial);
  // Tracking the previous key in STATE, not a ref, is what makes a → b → a reset rather than resurrect
  // the value last held under `a`.
  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    setValue(initial);
  }
  return [value, setValue];
}
