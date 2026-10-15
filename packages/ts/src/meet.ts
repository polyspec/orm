/**
 * The one table of which two columns compare alike on the three databases. dbspec's check validation and the IR
 * validator both read it, so the two cannot drift (docs/dbspec.md "Checks").
 */

/** The class of the types that share one: integers meet integers, and varchar meets text. */
const classes: Readonly<Record<string, string>> = { i16: 'integer', i32: 'integer', i64: 'integer', varchar: 'string', text: 'string' };

/**
 * The class of a column type: two columns meet when their kinds are equal. A decimal carries its scale and a time or
 * datetime its precision, since a different scale or precision compares differently; every other type is its own class.
 */
export function meetKind(type: string, scale: number, precision: number): string {
  const shared = classes[type];
  if (shared !== undefined) return shared;
  if (type === 'decimal') return `decimal scale ${scale}`;
  if (type === 'time' || type === 'datetime') return `${type} precision ${precision}`;
  return type;
}
