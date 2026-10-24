import assert from 'node:assert/strict';
import { COMPUTE, caseTest } from '../../../tests/testcase.mts';
import * as codes from '../dist/codes.js';
import { Db } from '../dist/database.js';
import { OrmError } from '../dist/runtime_error.js';

function makeFrame({ primary, setZero, restore }) {
  const calls = [];
  return {
    calls,
    async run(_kind, _tables, sql) {
      calls.push(sql);
      if (sql === 'PRAGMA busy_timeout') return { rows: [[375]] };
      if (sql === 'PRAGMA busy_timeout=0' && setZero) throw setZero;
      if (sql === 'PRAGMA busy_timeout=375' && restore) throw restore;
      if (sql.startsWith('INSERT') && primary) throw primary;
      return { rows: [] };
    },
  };
}

caseTest('SQLite NOWAIT busy_timeout restore outcomes preserve primary and cleanup errors', COMPUTE, async () => {
  const db = new Db({ name: 'sqlite' }, 'UTC', {});
  const primaryCause = { errcode: 5, message: 'database is locked' };
  const restore = new OrmError(codes.DRIVER, 'restore rejected');
  for (const [primaryFailure, restoreFailure] of [[false, false], [false, true], [true, false], [true, true]]) {
    const primary = primaryFailure ? new OrmError(codes.DRIVER, 'busy', primaryCause) : undefined;
    const frame = makeFrame({ primary, restore: restoreFailure ? restore : undefined });
    if (!primaryFailure && !restoreFailure) {
      await db.rowLock(frame, 'update_nowait');
    } else {
      await assert.rejects(db.rowLock(frame, 'update_nowait'), error => {
        if (primaryFailure && restoreFailure) {
          assert.equal(error.code, codes.LOCK_NOT_AVAILABLE);
          assert.equal(error.cause.errors[0].code, codes.LOCK_NOT_AVAILABLE);
          assert.equal(error.cause.errors[0].cause, primaryCause);
          assert.equal(error.cause.errors[1], restore);
        } else if (primaryFailure) {
          assert.equal(error.code, codes.LOCK_NOT_AVAILABLE);
          assert.equal(error.cause, primaryCause);
        } else {
          assert.equal(error, restore);
        }
        return true;
      });
    }
    assert.equal(frame.calls[0], 'PRAGMA busy_timeout');
    assert.equal(frame.calls[1], 'PRAGMA busy_timeout=0');
    assert.equal(frame.calls.at(-1), 'PRAGMA busy_timeout=375');
  }
  const setupCause = { errcode: 5, message: 'busy while setting NOWAIT' };
  const setup = new OrmError(codes.CANCELED, 'setting NOWAIT failed', setupCause);
  const frame = makeFrame({ setZero: setup, restore });
  await assert.rejects(db.rowLock(frame, 'update_nowait'), error => {
    assert.equal(error.code, codes.CANCELED);
    assert.deepEqual(error.cause.errors, [setup, restore]);
    return true;
  });
  assert.equal(frame.calls[0], 'PRAGMA busy_timeout');
  assert.deepEqual(frame.calls, ['PRAGMA busy_timeout', 'PRAGMA busy_timeout=0', 'PRAGMA busy_timeout=375']);
});
