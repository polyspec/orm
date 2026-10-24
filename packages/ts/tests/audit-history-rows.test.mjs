import assert from 'node:assert/strict';
import test from 'node:test';
import { auditHistoryRows } from './audit-history-rows.mjs';

test('projects audit history fields and preserves nullable and deleted state', () => {
  const core = Symbol('core');
  const row = fields => ({ [core]: { column: name => fields[name] } });
  assert.deepEqual(auditHistoryRows([
    row({ change: 'insert', previous_audit_seq: null, seq: 7, title: 'first', audit_seq: 1, deleted_at: null }),
    row({ change: 'update', previous_audit_seq: 1, seq: 7, title: 'second', audit_seq: 2, deleted_at: '2026-10-01' }),
  ], core), [
    ['insert', null, 7, 'first', 1, false],
    ['update', 1, 7, 'second', 2, true],
  ]);
});
