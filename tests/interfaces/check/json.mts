// The format of JSON that the interface check reads and writes. Symbol records and their hashes must be byte-for-byte what Go's encoding/json wrote, so
// goJson follows that rule: object keys are sorted in byte order, <, >, &, U+2028, U+2029 are written as \u escapes, and indentation is
// the MarshalIndent format. Values of conformance results and state contract compare numbers as their original text (i64 precision and
// the distinction between 1 and 1.0), so losslessJson reads numbers as JsonNumber.
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';

/** A JSON number kept as its source text, as Go's json.Number. */
export class JsonNumber {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** byteOrder compares two strings by their UTF-8 bytes, the order of Go's sort.Strings and of its JSON object keys. */
export function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** sortBytes sorts strings in place by their UTF-8 bytes and returns them. */
export function sortBytes(values: string[]): string[] {
  return values.sort(byteOrder);
}

// quote is a JSON string literal as Go writes it: JSON.stringify's escapes, and the HTML-safe escapes of Go.
function quote(value: string): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** goJson writes a value as Go's json.Marshal (indent empty) or json.MarshalIndent with the prefix "" and the indent. */
export function goJson(value: unknown, indent = ''): string {
  return write(value, indent, '');
}

function write(value: unknown, indent: string, current: string): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof JsonNumber) return value.text;
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  const inner = current + indent;
  const open = indent === '' ? '' : `\n${inner}`;
  const close = indent === '' ? '' : `\n${current}`;
  const comma = indent === '' ? ',' : `,\n${inner}`;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[${open}${value.map((item: unknown) => write(item, indent, inner)).join(comma)}${close}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => byteOrder(a, b));
    if (entries.length === 0) return '{}';
    const colon = indent === '' ? ':' : ': ';
    return `{${open}${entries.map(([key, item]) => `${quote(key)}${colon}${write(item, indent, inner)}`).join(comma)}${close}}`;
  }
  throw new Error(`json: unsupported value ${inspect(value)}`);
}

/** losslessJson parses JSON text with every number as a JsonNumber holding its source text. */
export function losslessJson(text: string): unknown {
  const value: unknown = JSON.parse(text, (_key: string, item: unknown, context?: { source?: string }) =>
    typeof item === 'number' ? new JsonNumber(context?.source ?? String(item)) : item);
  return value;
}

/** readLosslessJson is losslessJson of a file. */
export function readLosslessJson(path: string): unknown {
  return losslessJson(readFileSync(path, 'utf8'));
}

/** deepEqual compares two values parsed by losslessJson as Go's reflect.DeepEqual compares decoded JSON. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a instanceof JsonNumber || b instanceof JsonNumber) return a instanceof JsonNumber && b instanceof JsonNumber && a.text === b.text;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b || (a == null && b == null);
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item: unknown, index: number) => deepEqual(item, b[index]));
  }
  const left = Object.entries(a), right = new Map(Object.entries(b));
  return left.length === right.size && left.every(([key, item]) => right.has(key) && deepEqual(item, right.get(key)));
}
