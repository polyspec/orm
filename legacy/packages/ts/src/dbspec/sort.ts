// Ordering of the text keys that the dbspec emitters, renderers and planners sort by. Text compares by code unit, so the
// order does not depend on the locale.

/** Compares two texts by code unit: negative when a sorts first, positive when b sorts first, zero when they are equal. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A stable copy of items in key order. */
export function sortedBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => compareText(key(a), key(b)));
}
