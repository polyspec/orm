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
 * parse할 `path`의 dbspec document 파일을 읽는다. DBSPEC_SIGNATURE로 시작하지 않는 파일은
 * text 없이 line 1, column 1의 `signature` diagnostic 하나와 message
 * `<path> is not a dbspec document`를 돌려주며 parse하지 않는다. 읽을 수 없는 파일은
 * readFileSync의 error를 던진다.
 */
export function readDbspecFile(path: string): DbspecReadResult {
  if (typeof path !== 'string') throw new TypeError('dbspec file path must be a string');
  const bytes = readFileSync(path);
  // signature는 decode 전에 byte로 확인한다. 다른 형식의 파일과 빈 파일은 header가 아니라 signature diagnostic이다.
  if (bytes.length < signatureBytes.length || !bytes.subarray(0, signatureBytes.length).equals(signatureBytes)) {
    const diagnostic: DbspecDiagnostic = Object.freeze({ rule: 'signature', line: 1, column: 1, message: `${path} is not a dbspec document` });
    return Object.freeze({ text: null, diagnostics: Object.freeze([diagnostic]) });
  }
  return Object.freeze({ text: bytes.toString('utf8'), diagnostics: Object.freeze([]) as readonly [] });
}
