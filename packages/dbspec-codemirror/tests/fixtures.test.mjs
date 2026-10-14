// The CodeMirror adapter over the editor fixtures of tests/editor (docs/editor.md "Fixtures"): each .dbs read into an
// EditorState with the dbspec extension gives the fixture's tokens as marks, its diagnostics as lint diagnostics, its
// folding ranges through the fold service, and its formatted text through the format command. No DOM is used.
//
// Usage: node --test packages/dbspec-codemirror/tests/fixtures.test.mjs (after the build of this package)
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { EditorState } from '@codemirror/state';
import { foldService } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { caseTest } from '../../../tests/testcase.mts';
import { dbspec, dbspecDiagnostics, formatDbspec } from '../dist/index.js';

const TIMEOUT = 15000;
const dir = new URL('../../../tests/editor/', import.meta.url);
const names = readdirSync(dir).filter(name => name.endsWith('.dbs')).map(name => name.slice(0, -'.dbs'.length)).sort();

const stateOf = (doc, options) => EditorState.create({ doc, extensions: [dbspec(options)] });
const offset = (state, [line, character]) => state.doc.line(line + 1).from + character;

function marks(state) {
  const out = [];
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === 'function') continue;
    source.between(0, state.doc.length, (from, to, value) => { out.push([from, to, value.spec.class]); });
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function folds(state) {
  const out = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    for (const service of state.facet(foldService)) {
      const range = service(state, line.from, line.to);
      if (range === null) continue;
      assert.equal(range.from, line.to);
      out.push({ startLine: n - 1, endLine: state.doc.lineAt(range.to).number });
    }
  }
  return out;
}

function format(state) {
  let next = null;
  const handled = formatDbspec({ state, dispatch: transaction => { next = transaction.state; } });
  return { handled, text: (next ?? state).doc.toString() };
}

caseTest('the editor fixtures exist', TIMEOUT, () => {
  assert.ok(names.length > 0);
});

for (const name of names) {
  caseTest(`fixture ${name} through the CodeMirror adapter`, TIMEOUT, () => {
    const doc = readFileSync(new URL(`${name}.dbs`, dir), 'utf8');
    const expected = JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8'));
    const state = stateOf(doc);
    assert.deepEqual(marks(state), expected.tokens.map(t => [offset(state, t.range[0]), offset(state, t.range[1]), `cm-dbspec-${t.class}`]));
    assert.deepEqual(dbspecDiagnostics(state).map(d => [d.from, d.to, d.message]),
      expected.diagnostics.map(d => [offset(state, d.range[0]), offset(state, d.range[1]), `${d.rule}: ${d.message}`]));
    assert.deepEqual(folds(state), expected.folding);
    const result = format(state);
    if (expected.formatted === null) assert.deepEqual(result, { handled: false, text: doc });
    else assert.deepEqual(result, { handled: true, text: expected.formatted });
  });
}

caseTest('the set option resolves use lines', TIMEOUT, () => {
  const core = 'dbspec 1 core\n\ntable users {\n  id i64 identity\n  primary key (id)\n}\n';
  const shop = 'dbspec 1 shop\n\nuse core { users }\n\ntable orders {\n  id i64 identity\n  primary key (id)\n}\n';
  assert.match(dbspecDiagnostics(stateOf(shop))[0].message, /^use: /);
  assert.deepEqual(dbspecDiagnostics(stateOf(shop, { set: { core } })), []);
});

caseTest('a change of the document is analyzed again', TIMEOUT, () => {
  const state = stateOf('dbspec 1 shop\n');
  assert.deepEqual(dbspecDiagnostics(state), []);
  const next = state.update({ changes: { from: 0, to: 6, insert: 'dbspek' } }).state;
  assert.match(dbspecDiagnostics(next)[0].message, /^(header|signature): /);
});
