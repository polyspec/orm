// renderDbspec rejects a dialect that is none of mysql, postgres and sqlite with a TypeError naming it. The rendered
// statements of tests/dbspec/ddl.json run in dbspec-render.mjs.
//
// Usage: node --test packages/ts/tests/dbspec-render-dialect.mjs (after the build)
import { caseTest } from '../../../tests/testcase.mts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDbspec, renderDbspec } from '../dist/dbspec/index.js';

const root = new URL('../../../', import.meta.url);
const ddl = JSON.parse(readFileSync(new URL('tests/dbspec/ddl.json', root), 'utf8'));

caseTest('render rejects an unknown dialect', 15000, () => {
  const c = ddl.cases[0];
  const text = lines => lines.join('\n') + '\n';
  const documents = Object.keys(c.documents).map(name => {
    const set = {};
    for (const [other, lines] of Object.entries(c.documents)) if (other !== name) set[other] = text(lines);
    const result = parseDbspec(text(c.documents[name]), set);
    assert.deepEqual(result.diagnostics, [], `diagnostics of document ${name}`);
    return result.document;
  });
  assert.throws(() => renderDbspec(documents, 'oracle'), { name: 'TypeError', message: /oracle/ });
});
