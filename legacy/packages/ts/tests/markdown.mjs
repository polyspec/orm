// The public bind-check transforms, and the bind cases of tests/bind/vectors.json (docs/spec/protocol.md §5). The session messages
// and the refused surfaces of a markdown connection are cases of the recipe tests/bind/messages.json.
//
// Usage: node packages/ts/tests/markdown.mjs (after npm run typescript:build)
import { isDeepStrictEqual } from 'node:util';
import { caseTest } from '../../../../tests/testcase.mts';
import { OrmError } from '../dist/index.js';
import { checkAssign, checkParam, transformParam } from '../dist/bind_check.js';
import * as publicIndex from '../dist/index.js';
import { readFileSync } from 'node:fs';

// D1 (T334-3-17-1): the bind-check transforms that Go, PHP, Python and Rust call publicly are public from the package entry.
if (typeof publicIndex.fulltextBoolean !== 'function' || typeof publicIndex.transformParam !== 'function') {
  throw new Error('D1: packages/ts/src/index.ts does not export fulltextBoolean and transformParam');
}
if (publicIndex.transformParam('fulltext_boolean', 'alpha beta') !== '+alpha +beta*') {
  throw new Error('D1: the public transformParam does not transform fulltext_boolean');
}

const bind = JSON.parse(readFileSync(new URL('../../../tests/bind/vectors.json', import.meta.url), 'utf8'));
// Bind case of tests/bind/vectors.json: checks a parameter value against the logical type of its slot (docs/spec/protocol.md §5
// "Parameters"). These are the same cases as TestBindVectors in Go.
// Requirements: PRT-67, DIA-31.
function vectorValue(value) {
  if (value === null || typeof value !== 'object') return value;
  // A native value of the tagged kind: the host object a TypeScript program passes for it.
  if (value.native !== undefined) return new Date(Date.UTC(2024, 0, 2, 3, 4, 5));
  if (value.int !== undefined) return BigInt(value.int);
  if (value.f64 !== undefined) return Number(value.f64);
  if (value.bytes !== undefined) return new Uint8Array(Buffer.from(value.bytes, 'base64'));
  throw new Error(`value ${JSON.stringify(value)} has no host form`);
}
caseTest('bind/vectors', () => {
  for (const c of bind.bind) {
    let value = vectorValue(c.value);
    const slot = { type: c.slot.type, precision: c.slot.precision ?? 0, scale: c.slot.scale ?? 0, length: c.slot.length ?? 0 };
    let code = '';
    try {
      if (c.slot.transform !== undefined) value = transformParam(c.slot.transform, value);
      else {
        checkAssign(0, value, { ...slot, notNull: c.slot.not_null === true, column: 'column' });
        checkParam(0, value, slot, bind.zone);
      }
    } catch (error) {
      if (!(error instanceof OrmError)) throw error;
      code = error.code;
    }
    if (c.code !== undefined) {
      if (code !== c.code) throw new Error(`${c.name}: checkParam(${JSON.stringify(c.value)}) = ${code}; want ${c.code}`);
    } else if (code !== '' || !isDeepStrictEqual(value, vectorValue(c.bound))) {
      throw new Error(`${c.name}: checkParam(${JSON.stringify(c.value)}) = ${code}; want ${JSON.stringify(c.bound)} bound`);
    }
  }
});
