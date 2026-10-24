import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import { Catalog } from '../dist/dbspec/introspect_catalog.js';
import { importMermaid } from '../dist/dbspec/mermaid.js';

const diagram = 'erDiagram\n    account {\n        i64 id PK\n    }\n';

caseTest('dbspec/mermaid/catalog-build-failure-is-diagnostic', COMPUTE, () => {
  const result = importMermaid(diagram, 'invalid name');
  assert.equal(result.document, null);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].line, 1);
});

caseTest('dbspec/mermaid/unexpected-catalog-error-keeps-identity', COMPUTE, () => {
  const previous = Catalog.prototype.document;
  const cause = new Error('unexpected catalog failure');
  Catalog.prototype.document = function () { throw cause; };
  try {
    assert.throws(() => importMermaid(diagram, 'valid'), error => error === cause);
  } finally {
    Catalog.prototype.document = previous;
  }
});
