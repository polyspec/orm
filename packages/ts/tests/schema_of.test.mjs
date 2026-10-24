import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { schemaOf } from './schema_of.mjs';

test('returns the canonical manifest text and hash for a dbspec document', () => {
  const text = readFileSync(new URL('../../../contracts/fixtures/clock.dbs', import.meta.url), 'utf8');
  assert.deepEqual(schemaOf(text), {
    manifestText: 'dbspec 1 clock\n\ntable clock_event {\n  seq i64 identity\n  label varchar(32)\n  created_ts datetime(6) default now\n  primary key (seq)\n}\n',
    manifestHash: 'sha256:fab61fb83cfec00c4d7a4d257b610b87c6fdccd49e02a85848a41ba263bc1ffb',
  });
});
