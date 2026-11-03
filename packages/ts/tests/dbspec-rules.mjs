// dbspec rules that a JSON recipe cannot hold (docs/spec/feature-coverage.md FCV-2): a text with an unpaired surrogate or
// without a final line feed, and the types of the inputs and the frozen results.
//
// Usage: node --test packages/ts/tests/dbspec-rules.mjs (after the build)
import { caseTest } from '../../../tests/testcase.mts';
import assert from 'node:assert/strict';
import { emitDbspec, parseDbspec } from '../dist/dbspec/index.js';
import * as api from '../dist/index.js';

// TIMEOUT is the deadline (ms) of one case.
const TIMEOUT = 15000;

function rule(name, body) {
  caseTest(name, TIMEOUT, body);
}

const text = lines => lines.join('\n') + '\n';
const users = ['table users {', '  id i64 identity', '  primary key (id)', '}'];

function invalid(name, source, errors) {
  rule(`invalid ${name}`, () => {
    const result = parseDbspec(source, {});
    assert.equal(result.document, null);
    assert.deepEqual(result.diagnostics.map(d => [d.rule, d.line, d.column]), errors);
  });
}

// Requirements: DBS-144.
invalid('unpaired surrogate', "dbspec 1 shop\n# \uD800\ntable Users {\n", [['encoding', 2, 3]]);
invalid('final bare CR', 'dbspec 1 shop\r', [['encoding', 1, 14]]);

rule('inputs are strings and documents are frozen', () => {
  assert.throws(() => parseDbspec(Buffer.from('dbspec 1 shop\n'), {}), TypeError);
  assert.throws(() => parseDbspec('dbspec 1 shop\n', { core: 1 }), TypeError);
  assert.throws(() => parseDbspec('dbspec 1 shop\n', null), TypeError);
  const result = parseDbspec(text(['dbspec 1 shop', ...users]), {});
  assert(Object.isFrozen(result) && Object.isFrozen(result.document) && Object.isFrozen(result.document.tables[0].columns[0]));
  assert.equal(api.parseDbspec, parseDbspec);
  assert.equal(api.emitDbspec, emitDbspec);
});
