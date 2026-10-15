// The set parse vectors (tests/dbspec/set-parse.json, docs/dbspec.md "Parsing a set"). Every case runs through
// parseDbspecSet from the Node entry and from the browser-safe `@polyspec/orm/dbspec` entry: the name, the external
// mark, whether the text parsed and the diagnostics of each text. The vector file is
// read strictly: an unknown or a missing field is an error, and no case is skipped.
//
// Usage: node --test packages/ts/tests/dbspec-set-parse.mjs (after the build)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMPUTE, caseTest } from '../../../tests/testcase.mts';
import { parseDbspecSet } from '../dist/index.js';
import { parseDbspecSet as browserParseDbspecSet } from '../dist/dbspec/entry.js';

const vectorPath = fileURLToPath(new URL('../../../tests/dbspec/set-parse.json', import.meta.url));
const vectors = JSON.parse(readFileSync(vectorPath, 'utf8'));

/** Asserts that `value` is a plain object with exactly the keys `keys`. */
function exactKeys(value, keys, where) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${where} is an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${where} has exactly the keys ${keys.join(', ')}`);
}

/** Reads a wanted diagnostic: its rule, line and column, and its message when the vector states one. */
function wantDiagnostic(d, where) {
  assert.ok(d !== null && typeof d === 'object', `${where} is an object`);
  const keys = Object.keys(d).sort();
  assert.ok(
    JSON.stringify(keys) === JSON.stringify(['column', 'line', 'rule']) || JSON.stringify(keys) === JSON.stringify(['column', 'line', 'message', 'rule']),
    `${where} has the keys rule, line, column and an optional message`,
  );
  return d;
}

/** The fields of a diagnostic that the wanted one states. */
function stated(got, want) {
  return Object.fromEntries(Object.keys(want).map(k => [k, got[k]]));
}

exactKeys(vectors, ['schema', 'cases'], 'set-parse.json');
assert.equal(vectors.schema, 1, 'set-parse.json schema');
assert.ok(Array.isArray(vectors.cases) && vectors.cases.length > 0, 'set-parse.json cases');

for (const [index, c] of vectors.cases.entries()) {
  const where = `cases[${index}]`;
  exactKeys(c, ['id', 'name', 'owned', 'external', 'documents'], where);
  c.documents.forEach((d, i) => {
    exactKeys(d, ['name', 'external', 'parsed', 'diagnostics'], `${where}.documents[${i}]`);
    d.diagnostics.forEach((x, j) => wantDiagnostic(x, `${where}.documents[${i}].diagnostics[${j}]`));
  });
  // One test for each case, named by its id, runs the case through the Node and the browser entry.
  caseTest(c.id, COMPUTE, () => {
    for (const [entry, parse] of [['node', parseDbspecSet], ['browser', browserParseDbspecSet]]) {
      const got = parse(c.owned, c.external);
      assert.equal(got.length, c.documents.length, `${entry}: one result per text`);
      got.forEach((d, i) => {
        const want = c.documents[i];
        assert.equal(d.name ?? '', want.name, `documents[${i}].name`);
        assert.equal(d.external, want.external, `documents[${i}].external`);
        assert.equal(d.document !== null, want.parsed, `documents[${i}] parsed`);
        if (d.document !== null) {
          assert.equal(d.document.name, want.name, `documents[${i}].document.name`);
          assert.equal(d.document.external === true, want.external, `documents[${i}].document.external`);
          assert.ok(Array.isArray(d.positions), `documents[${i}].positions`);
        }
        assert.deepEqual(d.diagnostics.map((x, j) => stated(x, want.diagnostics[j] ?? {})), want.diagnostics, `documents[${i}].diagnostics`);
      });
    }
  });
}
