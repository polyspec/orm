// A value that the code knows to be there although its type admits undefined: an entry of a list or a record at a known
// key, or a group of a regular expression that takes part in every match (noUncheckedIndexedAccess). The read states what
// it expects and fails with that, instead of asserting it away with `!` or a type assertion (K156, K157).

/**
 * `value`, which the code knows to be there; throws an Error that names `what` when it is undefined or null.
 *
 * @internal
 */
export function present<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`${what} is missing`);
  return value;
}
