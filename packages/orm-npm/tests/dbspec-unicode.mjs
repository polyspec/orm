// The word table of the TypeScript client (src/dbspec/unicode_word.ts, generated from Go's unicode data by
// go run ./tests/dbspec/unicode -write) agrees with its own ranges at every code point. Go's ranges are
// checked against Go by that generator's test.
//
// Usage: node --test packages/orm-npm/tests/dbspec-unicode.mjs (after the build)
import { caseTest } from '../../../tests/testcase.mjs';
import assert from 'node:assert/strict';
import { containsWordRune, WORD_RANGES } from '../dist/dbspec/unicode_word.js';

const LAST_CODE_POINT = 0x10ffff;
// TIMEOUT은 case 하나의 기한(ms)이다. 모든 code point의 이진 탐색과 bitmap 한 번이다.
const TIMEOUT = 60000;

caseTest('every code point is classified by the ranges of the table', TIMEOUT, () => {
  // listed[cp] is 1 exactly when cp lies in one of the table's ranges.
  const listed = new Uint8Array(LAST_CODE_POINT + 1);
  for (const [lo, hi] of WORD_RANGES) listed.fill(1, lo, hi + 1);
  const disagree = [];
  for (let cp = 0; cp <= LAST_CODE_POINT; cp++) {
    if (containsWordRune(cp) !== (listed[cp] === 1)) {
      disagree.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
      if (disagree.length === 10) break;
    }
  }
  assert.deepEqual(disagree, [], 'containsWordRune differs from the ranges; run go run ./tests/dbspec/unicode -write');
});
