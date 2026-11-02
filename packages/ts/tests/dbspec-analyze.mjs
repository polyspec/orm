// dbspec analyze. analyzeDbspec gives the tokens of the header line. The tokens of the documents run from their recipes
// (recipe_<section>.mjs, and the analyze steps of hashes.json and sets.json).
//
// Usage: node --test packages/ts/tests/dbspec-analyze.mjs (after the build)
import { caseTest } from '../../../tests/testcase.mts';
import { vectorRegistrar } from '../../../tests/vector-registrar.mjs';
import assert from 'node:assert/strict';
import { analyzeDbspec } from '../dist/dbspec/index.js';
const TIMEOUT = 15000;

const vector = vectorRegistrar(caseTest, TIMEOUT);

// The first red of this item: the header line gives its keyword, number and name tokens.
// Requirements: DBS-134, DBS-135.
vector('analyze header line tokens', () => {
  const result = analyzeDbspec('dbspec 1 shop', {});
  assert.deepEqual(
    result.tokens.map(t => [t.line, t.start, t.end, t.class]),
    [[1, 0, 6, 'keyword'], [1, 7, 8, 'number'], [1, 9, 13, 'name']],
  );
});
