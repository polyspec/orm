import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import { markdownReadDatabase } from './markdown-read-db.mjs';

caseTest('provides the model, fixed clock, and session expected by markdownRead', COMPUTE, async () => {
  const model = {};
  const session = {};
  const db = markdownReadDatabase(model, session);
  assert.equal(db.markdownModel(), model);
  assert.equal(db.zone, undefined);
  assert.equal(db.signal, undefined);
  assert.equal(db.clockMicros(), 0);
  assert.equal(db.now(), '2026-01-01 00:00:00.000000');
  assert.equal(await db.md.acquire(), session);
  assert.doesNotThrow(() => db.md.release());
});
