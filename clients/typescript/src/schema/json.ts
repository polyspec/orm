// Canonical JSON: the byte form the schema builder writes. Strings use the
// escaping of the reference encoder (HTML characters and line separators are
// escaped) and object keys of maps are sorted by their UTF-8 bytes.

const hex = '0123456789abcdef';

export function jsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { out += s[i]! + s[i + 1]!; i++; continue; }
      out += '\\ufffd';
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) { out += '\\ufffd'; continue; }
    switch (c) {
      case 0x22: out += '\\"'; continue;
      case 0x5c: out += '\\\\'; continue;
      case 0x08: out += '\\b'; continue;
      case 0x0c: out += '\\f'; continue;
      case 0x0a: out += '\\n'; continue;
      case 0x0d: out += '\\r'; continue;
      case 0x09: out += '\\t'; continue;
      case 0x3c: case 0x3e: case 0x26: case 0x2028: case 0x2029:
        out += '\\u' + c.toString(16).padStart(4, '0'); continue;
    }
    if (c < 0x20) { out += '\\u00' + hex[c >> 4] + hex[c & 15]; continue; }
    out += s[i];
  }
  return out + '"';
}

/** Orders strings by their UTF-8 bytes. */
export function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

export function sortedKeys(o: object): string[] {
  return Object.keys(o).sort(byteOrder);
}

export function stringList(values: readonly string[] | null | undefined): string {
  if (values === null || values === undefined) return 'null';
  return '[' + values.map(jsonString).join(',') + ']';
}

/** Writes the fields in order; `undefined` values are omitted. */
export function object(fields: ReadonlyArray<readonly [string, string | undefined]>): string {
  const parts: string[] = [];
  for (const [key, value] of fields) if (value !== undefined) parts.push(jsonString(key) + ':' + value);
  return '{' + parts.join(',') + '}';
}

export function map<T>(values: Readonly<Record<string, T>> | null | undefined, encode: (value: T) => string): string {
  if (values === null || values === undefined) return 'null';
  return '{' + sortedKeys(values).map(key => jsonString(key) + ':' + encode(values[key]!)).join(',') + '}';
}

export function list<T>(values: readonly T[] | null | undefined, encode: (value: T) => string): string {
  if (values === null || values === undefined) return 'null';
  return '[' + values.map(encode).join(',') + ']';
}

/** omitempty for strings. */
export function optString(s: string | undefined): string | undefined {
  return s === undefined || s === '' ? undefined : jsonString(s);
}

/** omitempty for booleans. */
export function optBool(b: boolean | undefined): string | undefined {
  return b ? 'true' : undefined;
}

/** omitempty for integers. */
export function optInt(n: number | undefined): string | undefined {
  return n === undefined || n === 0 ? undefined : String(n);
}

/** omitempty for slices and maps. */
export function optList<T>(values: readonly T[] | null | undefined, encode: (value: T) => string): string | undefined {
  return values === null || values === undefined || values.length === 0 ? undefined : list(values, encode);
}

export function optMap<T>(values: Readonly<Record<string, T>> | null | undefined, encode: (value: T) => string): string | undefined {
  return values === null || values === undefined || Object.keys(values).length === 0 ? undefined : map(values, encode);
}

/** Quotes a string the way the reference formatter's %q verb does. */
export function quoted(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    switch (ch) {
      case '"': out += '\\"'; continue;
      case '\\': out += '\\\\'; continue;
      case '\x07': out += '\\a'; continue;
      case '\b': out += '\\b'; continue;
      case '\f': out += '\\f'; continue;
      case '\n': out += '\\n'; continue;
      case '\r': out += '\\r'; continue;
      case '\t': out += '\\t'; continue;
      case '\v': out += '\\v'; continue;
    }
    if (c < 0x20 || c === 0x7f) { out += '\\x' + hex[c >> 4] + hex[c & 15]; continue; }
    if (c === 0x20 || !/[\p{C}\p{Z}]/u.test(ch)) { out += ch; continue; }
    out += c > 0xffff ? '\\U' + c.toString(16).padStart(8, '0') : '\\u' + c.toString(16).padStart(4, '0');
  }
  return out + '"';
}

/** Formats a string list the way the reference formatter's %v verb does. */
export function listText(values: readonly string[] | null | undefined): string {
  return '[' + (values ?? []).join(' ') + ']';
}
