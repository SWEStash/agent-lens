/** A copy of `set` with `key` flipped — added if absent, removed if present. For `setState(prev => …)`. */
export function toggleIn<T>(set: ReadonlySet<T>, key: T): Set<T> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
