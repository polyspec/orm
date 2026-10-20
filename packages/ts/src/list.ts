// Comparison of two lists of text, shared by the planners and the markdown reader.

/** Reports whether two lists hold the same texts in the same order. */
export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
