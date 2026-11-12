/**
 * The quoting of a name or a text in an error message, which every runtime shares (INT-187, DBS-144): the delimiter, then
 * per code point the delimiter or `\` as a backslash and the character, BEL, BS, FF, LF, CR, TAB and VT as `\a`, `\b`, `\f`,
 * `\n`, `\r`, `\t` and `\v`, another code point below U+0020 and U+007F as `\x` and two lower-case hex digits, a lone
 * surrogate as `\u` and four lower-case hex digits, and any other code point as it is; then the delimiter. The quoting needs
 * no Unicode table.
 */
export function quote(text: string, delim: '"' | "'" = '"'): string {
  let out = delim;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const escape = ESCAPES.get(cp);
    if (ch === delim || ch === '\\') out += '\\' + ch;
    else if (escape !== undefined) out += escape;
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, '0')}`;
    else if (cp >= 0xd800 && cp <= 0xdfff) out += `\\u${cp.toString(16)}`;
    else out += ch;
  }
  return out + delim;
}

const ESCAPES = new Map<number, string>([
  [7, '\\a'],
  [8, '\\b'],
  [9, '\\t'],
  [10, '\\n'],
  [11, '\\v'],
  [12, '\\f'],
  [13, '\\r'],
]);

/** A decoder of well-formed UTF-8 only: quoteBytes hands it one whole sequence at a time. */
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** `bytes` in double quotes as `quote` writes their text, a byte that is not part of UTF-8 as `\x` and two lower-case hex digits. */
export function quoteBytes(bytes: Uint8Array): string {
  let out = '"';
  let at = 0;
  while (at < bytes.length) {
    const width = utf8Width(bytes, at);
    if (width === 0) {
      out += `\\x${(bytes[at] ?? 0).toString(16).padStart(2, '0')}`;
      at += 1;
    } else {
      out += quote(UTF8.decode(bytes.subarray(at, at + width))).slice(1, -1);
      at += width;
    }
  }
  return out + '"';
}

/** The length of the well-formed UTF-8 sequence at `at`, or 0 when the byte there starts none. */
function utf8Width(bytes: Uint8Array, at: number): number {
  const b0 = bytes[at] ?? 0;
  const cont = (i: number, lo = 0x80, hi = 0xbf): boolean => {
    const b = bytes[at + i];
    return b !== undefined && b >= lo && b <= hi;
  };
  if (b0 < 0x80) return 1;
  if (b0 >= 0xc2 && b0 <= 0xdf) return cont(1) ? 2 : 0;
  if (b0 === 0xe0) return cont(1, 0xa0) && cont(2) ? 3 : 0;
  if (b0 === 0xed) return cont(1, 0x80, 0x9f) && cont(2) ? 3 : 0;
  if (b0 >= 0xe1 && b0 <= 0xef) return cont(1) && cont(2) ? 3 : 0;
  if (b0 === 0xf0) return cont(1, 0x90) && cont(2) && cont(3) ? 4 : 0;
  if (b0 >= 0xf1 && b0 <= 0xf3) return cont(1) && cont(2) && cont(3) ? 4 : 0;
  if (b0 === 0xf4) return cont(1, 0x80, 0x8f) && cont(2) && cont(3) ? 4 : 0;
  return 0;
}
