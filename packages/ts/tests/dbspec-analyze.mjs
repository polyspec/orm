// dbspec analyze and format. analyzeDbspec gives the parse result unchanged with the tokens of the text, and the tokens of
// every shared case are those of tests/dbspec/syntax.json exactly (dbspec-syntax.mjs). formatDbspec formats the canonical and normalize cases to
// their canonical text, refuses the invalid cases with their diagnostics, and is idempotent.
//
// Usage: node --test packages/ts/tests/dbspec-analyze.mjs (after the build)
import { caseTest } from '../../../tests/testcase.mts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeDbspec, formatDbspec } from '../dist/dbspec/index.js';
import { generate, join, render, vectorInputs } from '../../../scripts/dbspec/syntax-vectors.mts';
import { readCases } from '../../../tests/dbspec/cases.mts';

const root = new URL('../../../', import.meta.url);
const cases = readCases();
const TIMEOUT = 15000;

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

// syntax.json is the output of the generator (scripts/dbspec/syntax-vectors.mts) over the shared cases; its cases run
// in dbspec-syntax.mjs.
const syntaxText = readFileSync(new URL('tests/dbspec/syntax.json', root), 'utf8');
vector('syntax.json is the generator output', () => {
  assert.equal(syntaxText, render(generate(analyzeDbspec, vectorInputs(cases))));
});

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
