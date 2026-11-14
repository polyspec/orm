import assert from 'node:assert/strict';
import { caseTest } from '../../../../tests/testcase.mts';
import { isInternalColumnError } from './internal-column-error.mjs';

caseTest('recognizes an internal error naming the missing column', () => {
  assert.equal(isInternalColumnError({ code: 'INTERNAL', message: 'author.missing_column is unavailable' }, 'author', 'missing_column'), true);
});

caseTest('rejects another code or another column', () => {
  assert.equal(isInternalColumnError({ code: 'COLUMN_UNKNOWN', message: 'author.missing_column' }, 'author', 'missing_column'), false);
  assert.equal(isInternalColumnError({ code: 'INTERNAL', message: 'author.other_column' }, 'author', 'missing_column'), false);
});
