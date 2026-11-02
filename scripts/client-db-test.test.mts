// The unit tests of the client database lanes: the Rust thread cap of the pooler lane (T343-1).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { rustPoolerThreadArguments, rustTargetPoolSize } from './client-db-test.mts';

const root = resolve(import.meta.dirname, '..');

test('the pooler lane caps the Rust test threads at the backend count per pool', () => {
  assert.deepEqual(rustPoolerThreadArguments(4, 4), ['--test-threads=1']);
  assert.deepEqual(rustPoolerThreadArguments(8, 4), ['--test-threads=2']);
  assert.deepEqual(rustPoolerThreadArguments(2, 4), ['--test-threads=1']);
});

test('the Rust pool size of the integration program is read from its declaration', () => {
  assert.equal(rustTargetPoolSize(root), 4);
});
