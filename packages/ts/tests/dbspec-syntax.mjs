// dbspec syntax vectors (tests/dbspec/syntax.json): the tokens of analyzeDbspec for every shared case are those of the
// file exactly, the analysis carries the parse result unchanged, and its tokens are in source order and do not overlap.
// Each case is a top-level test named by its id; dbspec-analyze.mjs checks that the file is the generator output.
//
// Usage: node --test packages/ts/tests/dbspec-syntax.mjs (after the build)
import { caseTest } from '../../../tests/testcase.mts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeDbspec, parseDbspec } from '../dist/dbspec/index.js';
import { vectorInputs } from '../../../scripts/dbspec/syntax-vectors.mts';
import { readCases } from '../../../tests/dbspec/cases.mts';

const root = new URL('../../../', import.meta.url);
const cases = readCases();
const TIMEOUT = 15000;
const CLASSES = new Set(['keyword', 'type', 'name', 'setting', 'number', 'string', 'operator', 'punctuation', 'comment', 'word']);

function vector(name, body) {
  caseTest(name, TIMEOUT, body);
}

// The shared vectors are read strictly: the file has exactly the fields of the format, and it is the generator's output.
const syntaxText = readFileSync(new URL('tests/dbspec/syntax.json', root), 'utf8');
const syntax = JSON.parse(syntaxText);
assert.deepEqual(Object.keys(syntax).sort(), ['cases', 'note', 'requirements', 'version']);
assert.equal(syntax.version, 1);
for (const c of syntax.cases) {
  assert.deepEqual(Object.keys(c).sort(), ['id', 'tokens']);
  for (const t of c.tokens) {
    assert.equal(t.length, 4, `token of ${c.id} has four fields`);
    assert(CLASSES.has(t[3]), `token class ${t[3]} of ${c.id}`);
  }
}
const inputs = vectorInputs(cases);
assert.deepEqual(syntax.cases.map(c => c.id), inputs.map(i => i.id), 'the case ids and their order');

// Each case's tokens are its recorded tokens. The analysis carries the parse result unchanged, and its tokens are in
// source order and do not overlap.
for (const [index, input] of inputs.entries()) {
  vector(input.id, () => {
    const result = analyzeDbspec(input.text, input.documents);
    assert.deepEqual(result.tokens.map(t => [t.line, t.start, t.end, t.class]), syntax.cases[index].tokens);
    const analysis = analyzeDbspec(input.text, input.documents);
    const parsed = parseDbspec(input.text, input.documents);
    assert.deepEqual({ document: analysis.document, positions: analysis.positions, diagnostics: analysis.diagnostics }, parsed);
    let previous = null;
    for (const t of analysis.tokens) {
      assert(t.start < t.end, 'a token has a width');
      if (previous !== null && previous.line === t.line) assert(previous.end <= t.start, 'tokens do not overlap');
      if (previous !== null) assert(previous.line <= t.line, 'tokens are in source order');
      previous = t;
    }
  });
}

