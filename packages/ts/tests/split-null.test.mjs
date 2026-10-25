import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import { splitRowKey } from '../dist/database.js';

const key = [{ column: 'id', index: 0 }];

// Requirements: PRT-35.
caseTest('split root merge rejects SQL NULL identity', COMPUTE, () => {
  assert.throws(
    () => splitRowKey([null], key),
    error => error.code === 'CODEC_DECODE' && error.message === 'CODEC_DECODE: split query row identity contains SQL NULL',
  );
  assert.throws(
    () => splitRowKey([0, null, ''], [key[0], { column: 'enabled', index: 1 }, { column: 'label', index: 2 }]),
    error => error.code === 'CODEC_DECODE' && error.message === 'CODEC_DECODE: split query row identity contains SQL NULL',
  );
});

// Requirements: PRT-35.
caseTest('split root merge retains falsey non-NULL identities', COMPUTE, () => {
  assert.notEqual(splitRowKey([0], key), splitRowKey([''], key));
  assert.notEqual(splitRowKey([false], key), splitRowKey([0], key));
  assert.notEqual(splitRowKey([''], key), splitRowKey(['0'], key));
  const compositeRefs = [key[0], { column: 'enabled', index: 1 }, { column: 'label', index: 2 }];
  assert.notEqual(splitRowKey([0, false, ''], compositeRefs), splitRowKey([0, true, ''], compositeRefs));
});
