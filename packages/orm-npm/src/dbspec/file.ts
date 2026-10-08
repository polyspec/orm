// dbspec document 파일 reader (docs/dbspec.md "Files"). 파일을 읽는 모든 tool이 이것으로
// 읽어, signature가 없는 파일을 parse 전에 거부한다.
import { readFileSync } from 'node:fs';
import type { DbspecDiagnostic } from './model.js';

/** 모든 dbspec document 파일의 첫 byte다. header `dbspec 1 <document>`가 이것으로 시작한다. */
export const DBSPEC_SIGNATURE = 'dbspec ';

const signatureBytes = Buffer.from(DBSPEC_SIGNATURE, 'utf8');

/** 파일 text와 diagnostic 없음, 또는 text 없는 signature diagnostic. */
export type DbspecReadResult =
  | { readonly text: string; readonly diagnostics: readonly [] }
  | { readonly text: null; readonly diagnostics: readonly DbspecDiagnostic[] };

/**
 * parse할 `path`의 dbspec document 파일을 읽고 그 byte를 path를 이름으로
 * readDbspecBytes로 확인한다. 읽을 수 없는 파일은 readFileSync의 error를 던진다.
 */
export function readDbspecFile(path: string): DbspecReadResult {
  if (typeof path !== 'string') throw new TypeError('dbspec file path must be a string');
  return readDbspecBytes(path, readFileSync(path));
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * 호출자가 자기 규칙으로 읽은 dbspec document 파일의 byte를 parse 전에 확인한다. `name`은
 * message가 파일을 가리키는 이름이다. DBSPEC_SIGNATURE로 시작하지 않는 byte는 text 없이
 * line 1, column 1의 `signature` diagnostic 하나와 message `<name> is not a dbspec document`를,
 * UTF-8이 아닌 byte는 첫 잘못된 byte의 줄과 칸에서 `encoding` diagnostic 하나와 message
 * `<name> is not valid UTF-8`을 돌려준다. 그 밖의 byte는 diagnostic 없이 그대로 text가 된다.
 */
export function readDbspecBytes(name: string, bytes: Uint8Array): DbspecReadResult {
  if (typeof name !== 'string') throw new TypeError('dbspec file name must be a string');
  if (!(bytes instanceof Uint8Array)) throw new TypeError('dbspec file bytes must be a Uint8Array');
  // signature는 decode 전에 byte로 확인한다. 다른 형식의 파일과 빈 파일은 header가 아니라 signature diagnostic이다.
  if (bytes.length < signatureBytes.length || !signatureBytes.every((b, i) => bytes[i] === b)) {
    return invalid({ rule: 'signature', line: 1, column: 1, message: `${name} is not a dbspec document` });
  }
  let text: string;
  try {
    // fatal decoder는 잘못된 byte를 U+FFFD로 바꾸지 않고 거부한다.
    text = utf8.decode(bytes);
  } catch {
    const [line, column] = invalidUtf8Position(bytes);
    return invalid({ rule: 'encoding', line, column, message: `${name} is not valid UTF-8` });
  }
  return Object.freeze({ text, diagnostics: Object.freeze([]) as readonly [] });
}

function invalid(diagnostic: DbspecDiagnostic): DbspecReadResult {
  return Object.freeze({ text: null, diagnostics: Object.freeze([Object.freeze(diagnostic)]) });
}

/** 첫 잘못된 UTF-8 byte의 줄과 칸(code point 단위)이다. 줄은 LF로 나눈다. */
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

/** `i`에서 시작하는 올바른 UTF-8 문자의 byte 수, 잘못된 byte이면 0이다. */
function utf8Size(bytes: Uint8Array, i: number): number {
  const b = bytes[i]!;
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
  const second = bytes[i + 1]!;
  if (second < low || second > high) return 0;
  for (let k = 2; k < size; k++) {
    const next = bytes[i + k]!;
    if (next < 0x80 || next > 0xbf) return 0;
  }
  return size;
}
