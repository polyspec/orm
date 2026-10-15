// The byte check of a dbspec document file (docs/dbspec.md "Files"). Every tool that reads a document file checks its
// bytes with readDbspecBytes before the parse, so a file without the signature is refused before it is parsed. This
// module reads no Node global and loads no driver: the bytes come from the caller, as a Uint8Array.
import { present } from '../present.js';
import type { DbspecDiagnostic } from './model.js';

/** The first bytes of every dbspec document file; the header `dbspec 1 <document>` starts with it. */
export const DBSPEC_SIGNATURE = 'dbspec ';

const signatureBytes = new TextEncoder().encode(DBSPEC_SIGNATURE);

/** The text of a file with no diagnostic, or a signature or encoding diagnostic and no text. */
export type DbspecReadResult =
  | { readonly text: string; readonly diagnostics: readonly [] }
  | { readonly text: null; readonly diagnostics: readonly DbspecDiagnostic[] };

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Checks the bytes of a dbspec document file that the caller read, before any parse. `name` is the name the messages
 * give the file. Bytes that do not start with DBSPEC_SIGNATURE return exactly one `signature` diagnostic at line 1,
 * column 1, with the message `<name> is not a dbspec document`, and no text. Bytes that are not UTF-8 return exactly
 * one `encoding` diagnostic at the line and column of the first invalid byte, with the message `<name> is not valid
 * UTF-8`, and no text. Any other bytes are the text, with no diagnostic.
 */
export function readDbspecBytes(name: string, bytes: Uint8Array): DbspecReadResult {
  if (typeof name !== 'string') throw new TypeError('dbspec file name must be a string');
  if (!(bytes instanceof Uint8Array)) throw new TypeError('dbspec file bytes must be a Uint8Array');
  // The signature is checked on the bytes, before decoding. A file of another format, and an empty file, get the
  // signature diagnostic, not a header diagnostic.
  if (bytes.length < signatureBytes.length || !signatureBytes.every((b, i) => bytes[i] === b)) {
    return invalid({ rule: 'signature', line: 1, column: 1, message: `${name} is not a dbspec document` });
  }
  let text: string;
  try {
    // The fatal decoder rejects an invalid byte; it does not replace it with U+FFFD.
    text = utf8.decode(bytes);
  } catch {
    const [line, column] = invalidUtf8Position(bytes);
    return invalid({ rule: 'encoding', line, column, message: `${name} is not valid UTF-8` });
  }
  const noDiagnostics: readonly [] = Object.freeze([]);
  return Object.freeze({ text, diagnostics: noDiagnostics });
}

function invalid(diagnostic: DbspecDiagnostic): DbspecReadResult {
  return Object.freeze({ text: null, diagnostics: Object.freeze([Object.freeze(diagnostic)]) });
}

/** The line and the column, in code points, of the first invalid UTF-8 byte. Lines are split at LF. */
function invalidUtf8Position(bytes: Uint8Array): [number, number] {
  let line = 1;
  let column = 1;
  for (let i = 0; i < bytes.length;) {
    const size = utf8Size(bytes, i);
    if (size === 0) break;
    if (bytes[i] === 0x0a) {
      line++;
      column = 1;
    } else {
      column++;
    }
    i += size;
  }
  return [line, column];
}

/** The byte count of the well-formed UTF-8 character that starts at `i`, or 0 when the byte there is invalid. */
function utf8Size(bytes: Uint8Array, i: number): number {
  const b = present(bytes[i], 'bytes[i]');
  let size: number;
  let low = 0x80;
  let high = 0xbf;
  if (b < 0x80) return 1;
  else if (b >= 0xc2 && b <= 0xdf) size = 2;
  else if (b === 0xe0) { size = 3; low = 0xa0; }
  else if (b === 0xed) { size = 3; high = 0x9f; }
  else if (b >= 0xe1 && b <= 0xef) size = 3;
  else if (b === 0xf0) { size = 4; low = 0x90; }
  else if (b >= 0xf1 && b <= 0xf3) size = 4;
  else if (b === 0xf4) { size = 4; high = 0x8f; }
  else return 0;
  if (i + size > bytes.length) return 0;
  const second = present(bytes[i + 1], 'bytes[i + 1]');
  if (second < low || second > high) return 0;
  for (let k = 2; k < size; k++) {
    const next = present(bytes[i + k], 'bytes[i + k]');
    if (next < 0x80 || next > 0xbf) return 0;
  }
  return size;
}
