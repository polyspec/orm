// renderDbspec rejects a dialect that is none of mysql, postgres and sqlite with a TypeError naming it. The rendered
// statements of tests/dbspec/ddl.json run in dbspec-render.mjs.
//
// Usage: node --test packages/ts/tests/dbspec-render-dialect.mjs (after the build)
import { caseTest } from '../../../tests/testcase.mts';
import { vectorRegistrar } from '../../../tests/vector-registrar.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderDbspec } from '../dist/dbspec/index.js';
import { parseDocuments } from './parse_documents.mjs';

const root = new URL('../../../', import.meta.url);
const ddl = JSON.parse(readFileSync(new URL('tests/dbspec/ddl.json', root), 'utf8'));

// DBS-174: renderDbspec refuses a dialect that is none of mysql, postgres and sqlite with a TypeError that names it.
const vector = vectorRegistrar(caseTest, 15000);
vector('render rejects an unknown dialect', () => {
  const c = ddl.cases[0];
  const documents = parseDocuments(c.documents);
  assert.throws(() => renderDbspec(documents, 'oracle'), { name: 'TypeError', message: /oracle/ });
});
