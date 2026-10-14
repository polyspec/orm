// dbspec analyze and format. analyzeDbspec gives the parse result unchanged with the tokens of the text, and the tokens of
// every shared case are those of tests/dbspec/syntax.json exactly. formatDbspec formats the canonical and normalize cases to
// their canonical text, refuses the invalid cases with their diagnostics, and is idempotent.
//
// Usage: node --test packages/ts/tests/dbspec-analyze.mjs (after the build)
import { caseTest } from '../../../tests/testcase.mts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyzeDbspec, formatDbspec, parseDbspec } from '../dist/dbspec/index.js';
import { generate, join, render, vectorInputs } from '../../../scripts/dbspec/syntax-vectors.mts';
import { readCases } from '../../../tests/dbspec/cases.mts';

const root = new URL('../../../', import.meta.url);
const cases = readCases();
const TIMEOUT = 15000;
const CLASSES = new Set(['keyword', 'type', 'name', 'setting', 'number', 'string', 'operator', 'punctuation', 'comment', 'word']);

function vector(name, body) {
  caseTest(name, TIMEOUT, body);
}

// The first red of this item: the header line gives its keyword, number and name tokens.
vector('analyze header line tokens', () => {
  const result = analyzeDbspec('dbspec 1 shop', {});
  assert.deepEqual(
    result.tokens.map(t => [t.line, t.start, t.end, t.class]),
    [[1, 0, 6, 'keyword'], [1, 7, 8, 'number'], [1, 9, 13, 'name']],
  );
});

// The shared vectors are read strictly: the file has exactly the fields of the format, and it is the generator's output.
const syntaxText = readFileSync(new URL('tests/dbspec/syntax.json', root), 'utf8');
const syntax = JSON.parse(syntaxText);
assert.deepEqual(Object.keys(syntax).sort(), ['cases', 'note', 'version']);
assert.equal(syntax.version, 1);
for (const c of syntax.cases) {
  assert.deepEqual(Object.keys(c).sort(), ['id', 'tokens']);
  for (const t of c.tokens) {
    assert.equal(t.length, 4, `token of ${c.id} has four fields`);
    assert(CLASSES.has(t[3]), `token class ${t[3]} of ${c.id}`);
  }
}
const inputs = vectorInputs(cases);
const expected = generate(analyzeDbspec, inputs);
assert.deepEqual(syntax.cases.map(c => c.id), inputs.map(i => i.id), 'the case ids and their order');
vector('syntax.json is the generator output', () => {
  assert.equal(syntaxText, render(expected));
});

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

// formatDbspec: canonical cases emit unchanged, normalize cases emit their canonical lines, invalid cases are refused.
for (const c of cases.canonical) {
  vector(`format canonical ${c.id}`, () => {
    const text = join(c.documents[c.main], c.crlf === true, c.mixed === true);
    const set = Object.fromEntries(Object.entries(c.documents).filter(([name]) => name !== c.main).map(([name, lines]) => [name, join(lines, c.crlf === true, c.mixed === true)]));
    const formatted = formatDbspec(text, set);
    assert.deepEqual(formatted, { text, diagnostics: [] });
    assert.deepEqual(formatDbspec(formatted.text, set), formatted, 'formatting is idempotent');
  });
}

for (const c of cases.normalize) {
  vector(`format normalize ${c.id}`, () => {
    const text = join(c.documents[c.main], c.crlf === true, c.mixed === true);
    const set = Object.fromEntries(Object.entries(c.documents).filter(([name]) => name !== c.main).map(([name, lines]) => [name, join(lines, c.crlf === true, c.mixed === true)]));
    const canonical = join(c.canonical, false);
    const formatted = formatDbspec(text, set);
    assert.deepEqual(formatted, { text: canonical, diagnostics: [] });
    assert.deepEqual(formatDbspec(formatted.text, set), formatted, 'formatting is idempotent');
  });
}

for (const c of cases.invalid) {
  vector(`format refuses invalid ${c.id}`, () => {
    const text = join(c.documents[c.main], c.crlf === true, c.mixed === true);
    const set = Object.fromEntries(Object.entries(c.documents).filter(([name]) => name !== c.main).map(([name, lines]) => [name, join(lines, c.crlf === true, c.mixed === true)]));
    const formatted = formatDbspec(text, set);
    assert.equal(formatted.text, null);
    assert.deepEqual(formatted.diagnostics.map(d => ({ line: d.line, column: d.column, rule: d.rule })), c.errors);
  });
}
