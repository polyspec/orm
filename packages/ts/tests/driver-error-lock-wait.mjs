// A MySQL lock wait timeout (1205, innodb_lock_wait_timeout) is the expiry of the write bound of CFG-6, so driverError
// classifies it as CANCELED, not DRIVER. The case builds the error of the driver and needs no database.
//
// Usage: npm run typescript:build && node --test packages/ts/tests/driver-error-lock-wait.mjs
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driverError, openDriver, parseDsn } from '../dist/driver.js';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

caseTest('driver-error/lock-wait-timeout/mysql', COMPUTE, () => {
  const error = Object.assign(new Error('Lock wait timeout exceeded; try restarting transaction'), { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 });
  assert.equal(driverError('mysql', error).code, 'CANCELED');
});

// Requirements: PRT-79.
caseTest('driver-error/native-cause/mysql', COMPUTE, () => {
  const source = Object.assign(new Error('trigger refused the write'), { code: 'ER_SIGNAL_EXCEPTION', errno: 1644 });
  const mapped = driverError('mysql', source);
  assert.equal(mapped.code, 'DRIVER');
  assert.match(mapped.message, /mysql: trigger refused the write/);
  assert.strictEqual(mapped.cause, source);
});

async function withReservedSqliteSession(file, exercise) {
  const directory = mkdtempSync(join(tmpdir(), 'orm-ts-sqlite-cancel-'));
  const dsn = `sqlite://${join(directory, file)}`;
  let pool;
  let session;
  const release = () => {
    session?.release();
    session = undefined;
  };
  try {
    pool = openDriver(dsn, parseDsn(dsn), { size: 1, idleSize: 1, lifetimeMs: 0 }, 16);
    session = await pool.reserve();
    await exercise(pool, release);
  } finally {
    release();
    try { await pool?.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
  }
}

// Requirements: CFG-9. A pre-aborted SQLite statement does not wait behind a reserved connection.
caseTest('driver-cancel/sqlite/pre-aborted-while-queued', COMPUTE, async () => {
  await withReservedSqliteSession('pre-aborted.sqlite', async pool => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(pool.execute('SELECT 1', [], controller.signal, () => {}), error => error?.code === 'CANCELED');
    assert.equal(pool.stats().inUse, 1, 'cancellation must not release the held session');
  });
});

// Requirements: CFG-9. Aborting a queued SQLite statement removes its waiter without interrupting the holder.
caseTest('driver-cancel/sqlite/aborted-while-queued', COMPUTE, async () => {
  await withReservedSqliteSession('queued.sqlite', async (pool, release) => {
    const controller = new AbortController();
    const pending = pool.execute('SELECT 1', [], controller.signal, () => {});
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1, 'queued statement subscribes to cancellation');
    controller.abort();
    await assert.rejects(pending, error => error?.code === 'CANCELED');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'canceled waiter removes its listener');
    assert.equal(pool.stats().inUse, 1, 'cancellation must not release the held session');
    release();
    const result = await pool.execute('SELECT 1', [], undefined, () => {});
    assert.deepEqual(result.rows, [[1n]], 'pool remains usable after the holder releases');
  });
});
