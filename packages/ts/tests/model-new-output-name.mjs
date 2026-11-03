import assert from 'node:assert/strict';
import { caseTest } from '../../../tests/testcase.mts';
import { Author, OrmError } from '../dist/index.js';

// Requirements: DSL-116.
caseTest('a stored column name cannot be attached with new<Name>', 5000, () => {
  const author = new Author();
  assert.equal(author.setName('stored'), author);
  // The name goes through a value, since the scan refuses the call of newName on a stored column (DSL-116).
  const method = 'newName';
  assert.throws(() => author[method]('alias'), error => error instanceof OrmError && error.code === 'CONFIG');
});
