// dbspec analyze. analyzeDbspec gives the tokens of the header line, and tests/dbspec/syntax.json is the output of the
// generator (scripts/dbspec/syntax-vectors.mts) over the sets and hashes cases; its cases run in dbspec-syntax.mjs.
// The tokens and the format of the canonical, normalize and invalid documents run from their recipes (recipe_<section>.mjs).
//
// Usage: node --test packages/ts/tests/dbspec-analyze.mjs (after the build)
import { caseTest } from '../../../tests/testcase.mts';
import { vectorRegistrar } from '../../../tests/vector-registrar.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeDbspec } from '../dist/dbspec/index.js';
import { generate, render, vectorInputs } from '../../../scripts/dbspec/syntax-vectors.mts';
import { readCases } from '../../../tests/dbspec/cases.mts';

const root = new URL('../../../', import.meta.url);
const cases = readCases();
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

// syntax.json is the output of the generator (scripts/dbspec/syntax-vectors.mts) over the shared cases.
const syntaxText = readFileSync(new URL('tests/dbspec/syntax.json', root), 'utf8');
vector('syntax.json is the generator output', () => {
  assert.equal(syntaxText, render(generate(analyzeDbspec, vectorInputs(cases))));
});
