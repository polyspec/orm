// dbspec rendered statements (tests/dbspec/ddl.json): every case parses each
// document against the others and renders the document set in every dialect
// to exactly the listed statements.
//
// Usage: node --test packages/ts/tests/dbspec-render.mjs (after the build)
import { caseTest } from '../../../tests/testcase.mts';
import { vectorRegistrar } from '../../../tests/vector-registrar.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderDbspec } from '../dist/dbspec/index.js';
import { parseDocuments } from './parse_documents.mjs';

const root = new URL('../../../', import.meta.url);
const ddl = JSON.parse(readFileSync(new URL('tests/dbspec/ddl.json', root), 'utf8'));
// TIMEOUT is the deadline (ms) of one case. One render vector renders one document in memory into three dialects.
const TIMEOUT = 15000;
const DIALECTS = ['mysql', 'postgres', 'sqlite'];

const vector = vectorRegistrar(caseTest, TIMEOUT);

assert(ddl.cases.length > 0, 'ddl cases');
for (const c of ddl.cases) {
  assert.deepEqual(Object.keys(c.statements).sort(), DIALECTS, `dialects of ${c.id}`);
  vector(c.id, () => {
    for (const dialect of DIALECTS) {
      const documents = parseDocuments(c.documents);
      assert.deepEqual(renderDbspec(documents, dialect), { statements: c.statements[dialect], diagnostics: [] }, dialect);
      // The rendered order does not depend on the order of the given documents.
      assert.deepEqual(renderDbspec([...documents].reverse(), dialect), { statements: c.statements[dialect], diagnostics: [] }, dialect);
    }
  });
}
