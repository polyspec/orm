// The generator of tests/dbspec/syntax.json (scripts/dbspec/syntax-vectors.mts): generating the vectors again from
// cases.json and the built analyzeDbspec gives the committed file byte for byte, so the file never drifts from the cases
// or the analysis.
//
// Usage: node --test packages/ts/tests/syntax-vectors.mjs (after the build)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { caseTest } from '../../../tests/testcase.mts';
import { generate, render, vectorInputs } from '../../../scripts/dbspec/syntax-vectors.mts';
import { analyzeDbspec } from '../dist/dbspec/index.js';
import { readCases } from '../../../tests/dbspec/cases.mts';

const TIMEOUT = 30000;
const root = new URL('../../../', import.meta.url);

caseTest('syntax.json is what the generator writes from the current cases', TIMEOUT, () => {
  const cases = readCases();
  const committed = readFileSync(new URL('tests/dbspec/syntax.json', root), 'utf8');
  assert.equal(render(generate(analyzeDbspec, vectorInputs(cases))), committed, 'run node scripts/dbspec/syntax-vectors.mts and review the diff');
});
