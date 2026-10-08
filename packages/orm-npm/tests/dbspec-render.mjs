// dbspec rendered statements (tests/dbspec/ddl.json): every case parses each
// document against the others and renders the document set in every dialect
// to exactly the listed statements.
//
// Usage: node --test packages/orm-npm/tests/dbspec-render.mjs (after the build)
import { caseTest } from '../../../tests/testcase.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDbspec, renderDbspec } from '../dist/dbspec/index.js';

const root = new URL('../../../', import.meta.url);
const ddl = JSON.parse(readFileSync(new URL('tests/dbspec/ddl.json', root), 'utf8'));
// TIMEOUT은 case 하나의 기한(ms)이다. render vector 하나는 memory 안에서 문서 하나를 세 dialect로 렌더링한다.
const TIMEOUT = 15000;
const DIALECTS = ['mysql', 'postgres', 'sqlite'];

// vector runs one case with its own deadline and reports its start, result
// and elapsed time.
function vector(name, body) {
  caseTest(name, TIMEOUT, body);
}

const text = lines => lines.join('\n') + '\n';

// parseSet parses every document of a case against the others, in the order given.
function parseSet(c) {
  return Object.keys(c.documents).map(name => {
    const set = {};
    for (const [other, lines] of Object.entries(c.documents)) if (other !== name) set[other] = text(lines);
    const result = parseDbspec(text(c.documents[name]), set);
    assert.deepEqual(result.diagnostics, [], `diagnostics of document ${name}`);
    return result.document;
  });
}

assert(ddl.cases.length > 0, 'ddl cases');
for (const c of ddl.cases) {
  assert.deepEqual(Object.keys(c.statements).sort(), DIALECTS, `dialects of ${c.id}`);
  for (const dialect of DIALECTS) {
    vector(`render ${c.id} ${dialect}`, () => {
      const documents = parseSet(c);
      assert.deepEqual(renderDbspec(documents, dialect), { statements: c.statements[dialect], diagnostics: [] });
      // The rendered order does not depend on the order of the given documents.
      assert.deepEqual(renderDbspec([...documents].reverse(), dialect), { statements: c.statements[dialect], diagnostics: [] });
    });
  }
}

vector('render rejects an unknown dialect', () => {
  const documents = parseSet(ddl.cases[0]);
  assert.throws(() => renderDbspec(documents, 'oracle'), { name: 'TypeError', message: /oracle/ });
});
