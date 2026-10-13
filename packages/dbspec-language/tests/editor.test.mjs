// The editor fixtures of tests/editor: each .dbs with its .json of expected diagnostics, tokens, folding and formatted
// text. A .dbs without its .json, or the reverse, is a failure. The expected values are written by hand from the rules
// of docs/dbspec.md and docs/editor.md; a range is [[line, character], [line, character]] with 0-based lines and
// UTF-16 characters, and a folding range runs from the line of a `{` to the line of its matching `}`.
//
// Usage: node --test packages/dbspec-language/tests/editor.test.mjs (after the build)
import assert from 'node:assert/strict';
import { caseTest } from '../../../tests/testcase.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as language from '../dist/index.js';
import { repo } from './helpers.mjs';

// The deadline of one case; each case runs through caseTest so it reports its RUN, PASS or FAIL line.
const TIMEOUT = 15000;
const vector = (name, body) => caseTest(name, TIMEOUT, body);

const { openDocument } = language;
const dir = fileURLToPath(new URL('tests/editor/', repo));

/** The range of an expected value. */
function range([[startLine, startCharacter], [endLine, endCharacter]]) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

const dbsNames = readdirSync(dir).filter(f => f.endsWith('.dbs')).map(f => f.slice(0, -'.dbs'.length)).sort();
const jsonNames = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -'.json'.length)).sort();

vector('every editor fixture has its expected output and the reverse', () => {
  assert.deepEqual(jsonNames, dbsNames);
  assert.ok(dbsNames.length >= 4, 'at least four fixtures');
});

for (const name of dbsNames) {
  vector(`editor fixture ${name}`, () => {
    const text = readFileSync(`${dir}${name}.dbs`, 'utf8');
    const expected = JSON.parse(readFileSync(`${dir}${name}.json`, 'utf8'));
    const doc = openDocument(text, { set: {} });
    assert.deepEqual(doc.diagnostics, expected.diagnostics.map(d => ({ rule: d.rule, message: d.message, range: range(d.range) })));
    assert.deepEqual(doc.tokens, expected.tokens.map(t => ({ class: t.class, range: range(t.range) })));
    assert.deepEqual(doc.folding, expected.folding);
    const formatted = doc.format();
    if (expected.formatted === null) {
      assert.equal(formatted.text, null);
      assert.deepEqual(formatted.diagnostics, doc.diagnostics);
    } else {
      assert.deepEqual(formatted, { text: expected.formatted, diagnostics: [] });
      assert.equal(openDocument(expected.formatted, { set: {} }).format().text, expected.formatted, 'the formatted text is canonical');
    }
  });
}
